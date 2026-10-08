const CONFLUENCE_OPTIONS = [
  "MSS", "FVG", "HTF PD Array", "Liquidity Sweep",
  "Order Block", "Breaker Block", "Support Level", "Resistance Level",
];

function freshJournalEntry() {
  return { direction: "long", entryTime: "", entryPrice: "", exitPrice: "", notes: "", confluences: [] };
}

function getPageState(service) {
  const pageState = service.pageState ?? service;
  if (!pageState.newEntry) pageState.newEntry = freshJournalEntry();
  if (!Number.isInteger(pageState.screenshotCount)) pageState.screenshotCount = 0;
  return pageState;
}

function showToast(root, message) {
  const toast = root.querySelector("[data-toast]");
  if (!toast) return;
  toast.textContent = `[SYSTEM] ${message}`;
  toast.hidden = false;
  const windowRef = root.ownerDocument.defaultView;
  const previous = Number(toast.dataset.dismissTimer || 0);
  if (previous) windowRef?.clearTimeout(previous);
  const timer = windowRef?.setTimeout(() => {
    toast.hidden = true;
    toast.dataset.dismissTimer = "";
  }, 2400);
  if (timer) toast.dataset.dismissTimer = String(timer);
}

function renderConfluences(root, selected) {
  const documentRef = root.ownerDocument;
  const selectedMount = root.querySelector("[data-journal-selected-confluences]");
  const optionsMount = root.querySelector("[data-journal-available-confluences]");
  if (!selectedMount || !optionsMount) return;

  selectedMount.replaceChildren();
  optionsMount.replaceChildren();
  if (selected.length === 0) {
    const empty = documentRef.createElement("span");
    empty.textContent = "none selected";
    selectedMount.append(empty);
  } else {
    selected.forEach((confluence) => {
      const button = documentRef.createElement("button");
      button.type = "button";
      button.className = "conf-chip";
      button.dataset.journalConfluenceSelected = confluence;
      button.textContent = `${confluence} ×`;
      selectedMount.append(button);
    });
  }

  CONFLUENCE_OPTIONS.filter((confluence) => !selected.includes(confluence)).forEach((confluence) => {
    const button = documentRef.createElement("button");
    button.type = "button";
    button.className = "conf-opt";
    button.dataset.journalConfluenceOption = confluence;
    button.textContent = `+ ${confluence}`;
    optionsMount.append(button);
  });
}

function initializeNewEntryPage(root, service) {
  const form = root.querySelector("[data-journal-form]");
  if (!form) return;
  const pageState = getPageState(service);
  const draft = pageState.newEntry;
  const windowRef = root.ownerDocument.defaultView;
  let dirty = false, touched = false, disposed = false, saved = false, timer, revision = 0;
  const saveState = root.ownerDocument.createElement("p"); saveState.className = "workspace-save-state"; saveState.setAttribute("role", "status"); form.append(saveState);
  async function flush(keepalive = false) {
    windowRef.clearTimeout(timer);
    if (!dirty || saved || !service.saveDraft) return;
    const version = revision, snapshot = { ...draft, confluences: [...draft.confluences] };
    try { await service.saveDraft(snapshot, { keepalive }); if (version === revision) { dirty = false; if (!disposed) saveState.textContent = "Draft saved to your account"; } }
    catch { if (!disposed) saveState.textContent = "Draft not saved. Your text is still here; try Save draft again."; }
  }
  const changed = () => { touched = true; dirty = true; revision++; saveState.textContent = "Saving draft…"; windowRef.clearTimeout(timer); timer = windowRef.setTimeout(() => void flush(), 450); };
  const leaving = () => { void flush(true); };
  windowRef.addEventListener("pagehide", leaving);
  const screenshotCount = root.querySelector("[data-journal-screenshot-count]");
  const updateDirection = () => {
    root.querySelectorAll("[data-journal-direction]").forEach((button) => {
      const active = button.dataset.journalDirection === draft.direction;
      button.classList.toggle("on-long", active && draft.direction === "long");
      button.classList.toggle("on-short", active && draft.direction === "short");
      button.setAttribute("aria-pressed", String(active));
    });
  };
  const updateScreenshotCount = () => {
    if (screenshotCount) screenshotCount.textContent = `[ DROP CHART EVIDENCE :: ${pageState.screenshotCount} ATTACHED ]`;
  };

  for (const name of ["entryTime", "entryPrice", "exitPrice", "notes"]) {
    if (form.elements[name]) form.elements[name].value = draft[name];
    form.elements[name]?.addEventListener("input", (event) => { draft[name] = event.target.value; changed(); });
  }
  renderConfluences(root, draft.confluences);
  updateDirection();
  updateScreenshotCount();

  root.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-journal-direction], [data-journal-confluence-option], [data-journal-confluence-selected], [data-journal-save-draft]");
    if (!target || !root.contains(target)) return;
    if (target.dataset.journalDirection) {
      draft.direction = target.dataset.journalDirection;
      updateDirection(); changed();
      return;
    }
    if (target.dataset.journalConfluenceOption) {
      draft.confluences.push(target.dataset.journalConfluenceOption);
      renderConfluences(root, draft.confluences); changed();
      return;
    }
    if (target.dataset.journalConfluenceSelected) {
      draft.confluences = draft.confluences.filter((confluence) => confluence !== target.dataset.journalConfluenceSelected);
      renderConfluences(root, draft.confluences); changed();
      return;
    }
    if (target.hasAttribute("data-journal-save-draft")) { dirty = true; void flush(); }
  });

  root.querySelector("[data-journal-screenshots]")?.addEventListener("change", (event) => {
    pageState.screenshotCount = event.target.files?.length ?? 0;
    updateScreenshotCount();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    for (const name of ["entryTime", "entryPrice", "exitPrice", "notes"]) draft[name] = form.elements[name]?.value ?? "";
    const finish = (entry) => {
      saved = true; dirty = false; windowRef.clearTimeout(timer);
      service.saveDraft?.(null)?.catch(() => {});
      pageState.newEntry = freshJournalEntry();
      pageState.screenshotCount = 0;
      showToast(root, "ENTRY SUBMITTED :: SHARED DATABASE UPDATED");
      service.navigate?.(`/journal/${entry.id}`);
    };
    const fail = () => showToast(root, "ENTRY NOT SAVED :: TRY AGAIN");
    try {
      const entry = service.create({
        ...draft,
        confluences: draft.confluences.slice(),
        screenshotCount: pageState.screenshotCount,
      });
      if (entry?.then) entry.then(finish, fail);
      else finish(entry);
    } catch {
      fail();
    }
  });
  if (service.loadDraft) void service.loadDraft().then((stored) => {
    if (disposed || touched || !stored) return;
    Object.assign(draft, stored);
    draft.confluences = Array.isArray(stored.confluences) ? stored.confluences.slice() : [];
    for (const name of ["entryTime", "entryPrice", "exitPrice", "notes"]) if (form.elements[name]) form.elements[name].value = draft[name] ?? "";
    renderConfluences(root, draft.confluences); updateDirection(); saveState.textContent = "Saved draft restored";
  }).catch(() => { if (!disposed) saveState.textContent = "Saved draft unavailable. Your current text is retained."; });
  return { dispose() { leaving(); disposed = true; windowRef.clearTimeout(timer); windowRef.removeEventListener("pagehide", leaving); } };
}

function renderList(root, entries) {
  const documentRef = root.ownerDocument;
  const list = root.querySelector("[data-journal-list]");
  const empty = root.querySelector("[data-journal-empty]");
  if (!list) return;
  list.replaceChildren();
  if (empty) empty.hidden = entries.length > 0;

  entries.forEach((entry, index) => {
    const row = documentRef.createElement("a");
    row.className = "row";
    row.href = `/journal/${entry.id}`;
    row.dataset.navLink = "";
    row.style.animationDelay = `${index * 40}ms`;
    const direction = documentRef.createElement("span");
    direction.className = `tagbox ${entry.direction === "long" ? "t-green" : "t-red"}`;
    direction.textContent = entry.direction.toUpperCase();
    const time = documentRef.createElement("span");
    time.className = "journal-entry-time";
    time.textContent = entry.entryTime || "--";
    const confluences = documentRef.createElement("span");
    confluences.className = "journal-entry-confluences";
    confluences.textContent = (entry.confluences || []).join(" / ") || "no confluences tagged";
    const profitLoss = documentRef.createElement("span");
    profitLoss.className = `journal-entry-pl row-mono ${String(entry.pl).startsWith("-") ? "pl-neg" : "pl-pos"}`;
    profitLoss.textContent = entry.pl;
    row.append(direction, time, confluences, profitLoss);
    list.append(row);
  });
}

function renderPublicEntry(root, entry) {
  const documentRef = root.ownerDocument;
  const notFound = root.querySelector("[data-journal-not-found]");
  const publicView = root.querySelector("[data-journal-public-view]");
  if (!entry) {
    if (notFound) notFound.hidden = false;
    if (publicView) publicView.hidden = true;
    return;
  }
  if (notFound) notFound.hidden = true;
  if (publicView) publicView.hidden = false;

  const entryPath = `/journal/${encodeURIComponent(entry.id)}`;
  const origin = documentRef.defaultView?.location?.origin;
  const publicUrl = origin && origin !== "null" ? new URL(entryPath, origin).href : entryPath;
  const embed = [
    `TRADE: ${entry.direction.toUpperCase()}`,
    `ENTRY: ${entry.entryPrice}  EXIT: ${entry.exitPrice}`,
    `P&L: ${entry.pl}`,
    `CONFLUENCES: ${(entry.confluences || []).join(" / ") || "none"}`,
    `NOTES: ${(entry.notes || "").slice(0, 60)}`,
    `IMAGES: ${entry.screenshotCount} attachment(s)`,
    `PUBLIC ENTRY: ${publicUrl}`,
  ].join("\n");
  const embedMount = root.querySelector("[data-webhook-embed]");
  const linkMount = root.querySelector("[data-public-link]");
  if (embedMount) embedMount.textContent = embed;
  if (linkMount) linkMount.textContent = publicUrl;

  const record = root.querySelector("[data-journal-record]");
  if (!record) return;
  record.replaceChildren();
  const head = documentRef.createElement("div");
  head.className = "head";
  const direction = documentRef.createElement("span");
  direction.className = `tagbox ${entry.direction === "long" ? "t-green" : "t-red"}`;
  direction.textContent = entry.direction.toUpperCase();
  const profitLoss = documentRef.createElement("span");
  profitLoss.className = `pl ${String(entry.pl).startsWith("-") ? "pl-neg" : "pl-pos"}`;
  profitLoss.textContent = entry.pl;
  head.append(direction, profitLoss);
  const meta = documentRef.createElement("div");
  meta.className = "meta";
  meta.textContent = `ENTRY ${entry.entryPrice} → EXIT ${entry.exitPrice} :: ${entry.entryTime}`;
  const confluences = documentRef.createElement("div");
  confluences.className = "conf";
  const values = entry.confluences || [];
  if (values.length === 0) {
    const none = documentRef.createElement("span");
    none.textContent = "no confluences tagged";
    confluences.append(none);
  } else {
    values.forEach((value) => {
      const confluence = documentRef.createElement("span");
      confluence.textContent = value;
      confluences.append(confluence);
    });
  }
  const notes = documentRef.createElement("div");
  notes.className = "notes";
  notes.textContent = entry.notes || "(no notes recorded)";
  const screenshots = documentRef.createElement("div");
  screenshots.className = "shots";
  screenshots.textContent = `${entry.screenshotCount} SCREENSHOT(S) ATTACHED`;
  record.append(head, meta, confluences, notes, screenshots);
}

export function initializeJournalPage(root, service) {
  const key = root.dataset.routeKey;
  if (key === "journal-new") return initializeNewEntryPage(root, service);
  if (key === "journal") {
    const entries = service.list();
    if (entries?.then) entries.then((value) => renderList(root, value), () => renderList(root, []));
    else renderList(root, entries);
  }
  if (key === "journal-public") {
    const entry = service.find(root.dataset.entryId);
    if (entry?.then) entry.then((value) => renderPublicEntry(root, value), () => renderPublicEntry(root));
    else renderPublicEntry(root, entry);
    root.querySelector("[data-journal-copy-link]")?.addEventListener("click", async () => {
      const link = root.querySelector("[data-public-link]")?.textContent;
      try {
        await root.ownerDocument.defaultView?.navigator.clipboard?.writeText(link);
      } catch {
        // Clipboard permissions are optional; retain the legacy confirmation behavior.
      }
      showToast(root, "LINK COPIED");
    });
  }
}
