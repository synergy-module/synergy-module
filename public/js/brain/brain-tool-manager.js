export function createBrainToolManager(root, { request }) {
  const document = root.ownerDocument;
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = text => { const node = el("button", text, "btn"); node.type = "button"; return node; };
  let disposed = false, dialog, controller, generation = 0, opener;
  function close() { generation++; controller?.abort(); dialog?.remove(); dialog = null; opener?.focus?.({ preventScroll: true }); }
  async function open(sectionId = "agent:researcher") {
    close(); opener = document.activeElement; const current = ++generation;
    controller = new AbortController();
    dialog = el("dialog", undefined, "brain-tool-dialog"); dialog.setAttribute("aria-labelledby", "brain-tool-title");
    const header = el("header", undefined, "brain-tool-heading"), heading = el("h2", "Tool access"); heading.id = "brain-tool-title";
    const closeButton = button("Close"); closeButton.addEventListener("click", close);
    header.append(el("span", "BRAIN / ADMIN", "trader-micro"), heading, closeButton);
    const body = el("div", "Loading tool assignments…", "brain-tool-body"); body.setAttribute("aria-live", "polite");
    dialog.append(header, body); root.append(dialog); dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    const api = (url, value, method) => request(url, value, method, { signal: controller.signal });
    const alive = () => !disposed && current === generation;
    try {
      let snapshot = await api("/api/brain/tools"); if (!alive()) return;
      let selected = snapshot.sections.find(item => item.id === sectionId) ?? snapshot.sections[0];
      body.replaceChildren(); body.removeAttribute("aria-live");
      const intro = el("p", "Assignments apply to everyone on this site. An agent can use a tool only when both its assignment and the tool’s module gate are enabled.", "trader-help");
      const selectLabel = el("label", "BRAIN SECTION", "field"), select = el("select"); select.name = "section";
      for (const section of snapshot.sections) { const option = el("option", `${section.name} · ${section.kind === "agent" ? "Agent" : "Module gate"}`); option.value = section.id; select.append(option); }
      select.value = selected.id; selectLabel.append(select);
      const explanation = el("p", undefined, "trader-help"), form = el("form"), choices = el("div", undefined, "brain-tool-choices");
      const feedback = el("p", "", "brain-feedback"); feedback.setAttribute("role", "status");
      const actions = el("div", undefined, "trader-actions"), save = button("Save access"), reload = button("Reload assignments"); save.type = "submit";
      actions.append(save, reload); form.append(choices, actions, feedback);
      const audit = el("details", undefined, "brain-tool-audit"); audit.append(el("summary", "Recent access changes"));
      body.append(intro, selectLabel, explanation, form, audit);
      let dirty = false;
      function render(message = "") {
        choices.replaceChildren(); select.value = selected.id; dirty = false;
        explanation.textContent = selected.kind === "module" ? "Module gates control these tools for every agent. Turning a gate off blocks the next tool call, including calls in running missions." : "Checked tools are assigned to this agent. A blocked module gate must also be enabled. Planner and Critic can request assigned tools during their own stages.";
        const assigned = snapshot.policy.assignments[selected.id] ?? [];
        for (const tool of snapshot.catalog.filter(tool => selected.kind === "module" ? tool.module === selected.id : !tool.roles || tool.roles.includes(selected.role))) {
          const row = el("label", undefined, "brain-tool-choice"), input = el("input"); input.type = "checkbox"; input.name = "tools"; input.value = tool.id; input.checked = assigned.includes(tool.id);
          const description = el("span"), top = el("span", undefined, "brain-tool-choice-title"); top.append(el("strong", tool.name));
          const gate = snapshot.policy.assignments[tool.module]?.includes(tool.id), module = snapshot.sections.find(item => item.id === tool.module);
          const state = !tool.configured ? "Connection not configured" : selected.kind === "agent" && !gate ? `Blocked by ${module.name}` : selected.kind === "module" ? "Module gate" : "Module enabled";
          top.append(el("small", state)); description.append(top, el("span", tool.description, "brain-tool-description"));
          if (tool.id === "synergy-mcp") description.append(el("small", snapshot.synergyResearch?.connected ? `Connected · ${(snapshot.synergyResearch.counts?.artifact ?? 0).toLocaleString()} archived files · read-only` : "Source connection unavailable"));
          row.append(input, description); choices.append(row);
        }
        feedback.textContent = message || `Saved configuration · revision ${snapshot.policy.version}.`;
        audit.querySelector("ol")?.remove(); const list = el("ol");
        for (const event of snapshot.policy.history.slice(-8).reverse()) list.append(el("li", `${new Date(event.at).toLocaleString()} · ${event.section} · ${event.after.length} tools · admin ${event.actorId}`));
        if (!list.children.length) list.append(el("li", "No access changes yet.")); audit.append(list);
      }
      select.addEventListener("change", () => {
        if (dirty) { select.value = selected.id; feedback.textContent = "Save or reload your changes before selecting another section."; return; }
        selected = snapshot.sections.find(item => item.id === select.value); render();
      });
      choices.addEventListener("change", () => { dirty = true; feedback.textContent = "Unsaved changes. Save access to apply them site-wide."; });
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (save.disabled) return;
        save.disabled = reload.disabled = select.disabled = true; choices.querySelectorAll("input").forEach(input => { input.disabled = true; });
        const tools = [...choices.querySelectorAll("input:checked")].map(input => input.value);
        try {
          const result = await api(`/api/brain/tools/${encodeURIComponent(selected.id)}`, { version: snapshot.policy.version, tools }, "PUT");
          if (!alive()) return; snapshot.policy = result.policy; render("Access saved. The next tool call uses these permissions.");
        } catch (error) { if (alive()) feedback.textContent = error.message; }
        finally { if (alive()) { save.disabled = reload.disabled = select.disabled = false; choices.querySelectorAll("input").forEach(input => { input.disabled = false; }); save.focus(); } }
      });
      reload.addEventListener("click", async () => {
        save.disabled = reload.disabled = select.disabled = true;
        try { const updated = await api("/api/brain/tools"); if (!alive()) return; snapshot = updated; render("Assignments reloaded."); }
        catch (error) { if (alive()) feedback.textContent = error.message; }
        finally { if (alive()) save.disabled = reload.disabled = select.disabled = false; }
      });
      render();
      const browser = el("details", undefined, "brain-tool-library"); browser.append(el("summary", "Inspect Synergy MCP sources"));
      const help = el("p", "Admin source inspection is read-only. Search matches names and metadata; inspecting a source does not grant an agent access.", "trader-help");
      const searchForm = el("form", undefined, "trader-actions"), queryLabel = el("label", "FIND SHARED SOURCES", "field"), query = el("input"); query.name = "query"; query.required = true; query.minLength = 2; query.maxLength = 300; query.placeholder = "NQ, IFVG, or OVERVIEW.md"; queryLabel.append(query);
      const search = button("Search sources"); search.type = "submit"; searchForm.append(queryLabel, search);
      const libraryStatus = el("p", "", "brain-feedback"), results = el("div"), excerpt = el("pre", "", "synergy-source-text"), citation = el("p", "", "trader-help"), next = button("Read next excerpt"); libraryStatus.setAttribute("role", "status"); excerpt.hidden = next.hidden = true;
      browser.append(help, searchForm, libraryStatus, results, citation, excerpt, next); body.append(browser);
      let source, requestId = 0;
      async function read(item, offset = 0) {
        const id = ++requestId; libraryStatus.textContent = "Reading source…";
        try {
          const result = await api(`/api/brain/synergy/read?${new URLSearchParams({ kind: item.kind, id: item.id, offset })}`);
          if (!alive() || id !== requestId) return; source = result;
          citation.textContent = `${result.source.title} · ${result.citations?.[0]?.id ?? "Metadata only"}`;
          excerpt.textContent = result.excerpt || result.note || "Empty source."; excerpt.hidden = false; next.hidden = result.nextOffset == null;
          libraryStatus.textContent = result.truncated ? "Showing a bounded excerpt. Continue to read more." : "Source read from Synergy MCP.";
        } catch (error) { if (alive() && id === requestId) libraryStatus.textContent = error.message; }
      }
      searchForm.addEventListener("submit", async event => {
        event.preventDefault(); const id = ++requestId; results.replaceChildren(); citation.textContent = ""; excerpt.hidden = next.hidden = true; libraryStatus.textContent = "Searching…";
        try {
          const result = await api(`/api/brain/synergy/search?query=${encodeURIComponent(query.value)}`);
          if (!alive() || id !== requestId) return;
          for (const item of result.matches) { const sourceButton = button(item.title); sourceButton.classList.add("synergy-source-link"); sourceButton.addEventListener("click", () => void read(item)); results.append(sourceButton); }
          libraryStatus.textContent = result.matches.length ? "Select a source to read its contents." : "No matching names. Try a symbol, strategy, or file name.";
        } catch (error) { if (alive() && id === requestId) libraryStatus.textContent = error.message; }
      });
      next.addEventListener("click", () => { if (source?.nextOffset != null) void read(source.source, source.nextOffset); });
    } catch (error) { if (alive()) { body.textContent = error.message; const retry = button("Retry"); retry.addEventListener("click", () => void open(sectionId)); body.append(retry); } }
  }
  return { open, dispose() { disposed = true; close(); } };
}
