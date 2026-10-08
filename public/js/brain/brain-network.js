import { createBrainNetworkRenderer } from "./brain-network-renderer.js";

const ROLES = [
  { id: "planner", name: "PLANNER", region: "frontal-l", description: "Decomposes the objective into a bounded research plan.", position: [-.64, -.49, .12] },
  { id: "researcher", name: "RESEARCHER", region: "frontal-r", description: "Retrieves context, sources and saved evidence through allowed tools.", position: [.61, -.46, -.08] },
  { id: "strategist", name: "STRATEGIST", region: "temporal-l", description: "Builds a structured proposal from observed evidence and risk checks.", position: [.62, .43, .12] },
  { id: "critic", name: "CRITIC", region: "temporal-r", description: "Reviews the proposal and can request a revision before human review.", position: [-.63, .43, -.1] },
];
const MODULES = [
  { id: "risk", name: "RISK", region: "parietal", detail: "Checks thesis sizing and configured risk limits. Broker requests still require their own preview and human approval.", panel: "checks" },
  { id: "retrieval", name: "RETRIEVAL", region: "occipital", detail: "Finds relevant excerpts from your saved knowledge, approved memories and available journal entries.", panel: "knowledge" },
  { id: "memory", name: "MEMORY", region: "cerebellum", detail: "Stores research accepted during human review. Saved memories become evidence for future missions, never standing trade permissions.", panel: "knowledge" },
  { id: "robinhood", name: "ROBINHOOD", region: "stem", detail: "Connects broker research, order previews and a separate approval queue for stocks, options and crypto.", panel: "robinhood" },
];
const TOOL_ROLES = { "context.read": "researcher", "knowledge.search": "researcher", "memory.search": "researcher", "journal.search": "researcher", "calendar.read": "researcher", "risk.check": "strategist" };
const TOOL_POSITIONS = [[-.22, -.73, .18], [.25, -.75, -.12], [.85, -.04, -.16], [.29, .73, -.14], [-.26, .74, .12], [-.88, -.04, .03]];
const active = (value) => ["running", "active", "in_progress"].includes(value);
const safeArray = (value) => Array.isArray(value) ? value : [];
const label = (value) => String(value ?? "").replaceAll("_", " ");
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";

/** A read-only projection of saved application state. Decorative particles are not data nodes. */
export function buildBrainNetworkData(state = {}) {
  const providers = safeArray(state.providers), runs = safeArray(state.runs), documents = safeArray(state.documents);
  const run = state.selectedRun ?? runs[0] ?? null;
  const toolDefinitions = safeArray(state.toolDefinitions);
  const tools = [...new Map(toolDefinitions.filter((tool) => typeof tool?.name === "string").map((tool) => [tool.name, tool])).values()];
  const nodes = [{ id: "synergy-module", kind: "core", name: "SYNERGY MODULE", detail: "Agent orchestration", position: [0, 0, 0], status: active(run?.status) ? "running" : "idle" }];
  for (const role of ROLES) {
    const graph = safeArray(run?.graph?.nodes).filter((node) => node.role === role.id);
    const providerId = run?.input?.routes?.[role.id] || run?.input?.provider || state.defaultProvider;
    const provider = providers.find((entry) => entry.id === providerId);
    let status = graph.find((node) => active(node.status))?.status ?? graph.at(-1)?.status ?? "idle";
    // The planner creates the three-node graph; it is not itself a graph node.
    // Its validated plan and trace are the recorded completion evidence.
    if (role.id === "planner" && !graph.length) {
      const events = safeArray(run?.trace).filter((event) => event.agent === "planner");
      if (safeArray(run?.plan).length || events.some((event) => event.type === "plan")) status = "complete";
      else if (events.some((event) => event.type === "step")) status = active(run?.status) ? "running" : run?.status ?? "idle";
    }
    if (active(status) && ["failed", "cancelled"].includes(run?.status)) status = run.status;
    nodes.push({ ...role, id: `agent:${role.id}`, role: role.id, kind: "agent", status, parent: "synergy-module", detail: role.description,
      provider: run?.input?.mode === "demo" ? "Offline demo · no model calls" : provider ? `${provider.label ?? provider.id}${provider.model ? ` / ${provider.model}` : " · Not configured"}${run ? "" : " · default route"}` : "Assigned when a mission starts", panel: "mission" });
  }
  for (const module of MODULES) nodes.push({ ...module, id: `module:${module.id}`, kind: "module", parent: "synergy-module", position: [0, 0, 0], status: module.id === "robinhood" ? !state.brokerState ? "not checked" : state.brokerState.connected === true ? "connected" : "not connected" : "available" });
  tools.slice(0, 12).forEach((tool, index) => {
    const events = safeArray(run?.trace).filter((event) => event.details?.tool === tool.name);
    const observedRole = events.findLast((event) => ROLES.some((role) => role.id === event.agent))?.agent;
    const slot = TOOL_POSITIONS[index % TOOL_POSITIONS.length];
    nodes.push({ id: `tool:${tool.name}`, name: tool.name, kind: "tool", detail: tool.description || "Registered, permission-scoped research tool.",
      status: events.length ? "observed" : "available", observations: events.length, parent: `agent:${observedRole ?? TOOL_ROLES[tool.name] ?? "researcher"}`,
      position: [slot[0] * (index < 6 ? 1 : .77), slot[1] * (index < 6 ? 1 : .77), slot[2]], panel: "mission" });
  });
  documents.slice(0, 6).forEach((document, index) => {
    const angle = index * Math.PI / 3 + .28;
    nodes.push({ id: `document:${document.id}`, name: document.title || "Untitled source", kind: "memory", subtype: document.kind === "memory" ? "Approved memory" : "Knowledge source",
      detail: `${document.kind === "memory" ? "Saved after human review" : "Available to source retrieval"}. ${number(document.characters)} characters.`,
      status: "saved", parent: `tool:${document.kind === "memory" ? "memory.search" : "knowledge.search"}`,
      position: [Math.cos(angle) * .42, Math.sin(angle) * .52, -.26], panel: "knowledge" });
  });
  if (run) nodes.push({ id: `run:${run.id}`, name: `${run.input?.symbol || "CURRENT"} MISSION`, kind: "run", status: run.status, detail: run.input?.objective || "Inspect the saved mission, proposal and human review checkpoint.", position: [0, .48, .4], parent: "synergy-module", panel: "mission" });
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) if (node.parent && !ids.has(node.parent)) node.parent = "agent:researcher";
  return { nodes, run, runs, providers, brokerState: state.brokerState, counts: { agents: ROLES.length, tools: tools.length, documents: documents.length, memories: documents.filter((document) => document.kind === "memory").length, runs: runs.length }, paidCallsEnabled: state.paidCallsEnabled === true };
}

// Retain the view across in-app route changes, never across a document refresh.
const documentViews = new WeakMap();
const defaultView = () => ({ zoom: 1, yaw: -.28, pitch: .14, panX: 0, panY: 0 });

export function createBrainNetwork(host, { onNavigate = () => {} } = {}) {
  if (!host?.ownerDocument) return { update() {}, refresh() {}, dispose() {} };
  const document = host.ownerDocument, window = document.defaultView;
  const view = documentViews.get(document) ?? defaultView(); documentViews.set(document, view);
  const el = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
  const button = (text, className, ariaLabel) => { const item = el('button', text, className); item.type = 'button'; if (ariaLabel) item.setAttribute('aria-label', ariaLabel); return item; };
  let data = buildBrainNetworkData(), selectedId = null, disposed = false, frame = null, lastPaint = null, lastFrameTime = null, sceneTime = 0;
  let width = 1000, height = 700, drag = null, intersecting = true, moveMode = false;
  const motionQuery = window?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let paused = Boolean(motionQuery?.matches);
  const listeners = [], lobeButtons = new Map();
  const listen = (target, event, handler, options) => { target?.addEventListener?.(event, handler, options); listeners.push(() => target?.removeEventListener?.(event, handler, options)); };
  const shell = el('section', undefined, 'brain-network-shell'); shell.setAttribute('aria-label', 'Interactive neural network');
  const stage = el('div', undefined, 'brain-network-stage'); stage.tabIndex = 0;
  stage.setAttribute('aria-label', 'Neural network. Drag or use arrow keys to rotate. Shift-drag or Shift-arrow keys to move. Select a labeled region to explore.');
  const canvas = el('canvas', undefined, 'brain-network-canvas'); canvas.setAttribute('aria-hidden', 'true');
  let context = null;
  if (typeof window?.CanvasRenderingContext2D === 'function') { try { context = canvas.getContext('2d', { alpha: true }); } catch { /* Labels remain available without canvas. */ } }
  const palette = () => { const theme = window?.getComputedStyle?.(host); return { red: theme?.getPropertyValue('--red').trim(), glow: theme?.getPropertyValue('--red-glow').trim(), line: theme?.getPropertyValue('--line-strong').trim(), mono: theme?.getPropertyValue('--font-mono').trim(), dark: document.documentElement.dataset.theme !== 'daylight' }; };
  let canvasColors = palette();
  const renderCanvas = context ? createBrainNetworkRenderer(context, canvasColors) : null;
  const grid = el('div', undefined, 'brain-network-grid'); grid.setAttribute('aria-hidden', 'true');
  const labels = el('div', undefined, 'brain-network-labels'); labels.setAttribute('role', 'group'); labels.setAttribute('aria-label', 'Explore network regions');
  const coordinate = el('span', 'SYNERGY MODULE / NEURAL NETWORK', 'brain-network-coordinate');
  const mode = el('span', 'IDLE', 'brain-network-mode');
  const controls = el('div', undefined, 'brain-network-controls'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Network view controls');
  const rotate = button('Rotate', undefined, 'Rotate network'), move = button('Move', undefined, 'Move network');
  const zoomOut = button('−', undefined, 'Zoom out'), zoomIn = button('+', undefined, 'Zoom in');
  const reset = button('↺', undefined, 'Reset network view'), motion = button(paused ? '▷' : 'Ⅱ', undefined, 'Pause network motion');
  const zoomLabel = el('output', `${Math.round(view.zoom * 100)}%`, 'brain-network-zoom'); zoomLabel.setAttribute('aria-label', 'Network zoom');
  rotate.setAttribute('aria-pressed', 'true'); move.setAttribute('aria-pressed', 'false');
  controls.append(rotate, move, zoomOut, zoomLabel, zoomIn, reset, motion);
  const hint = el('span', 'Drag to rotate · Shift-drag to move · Select a region', 'brain-network-hint');
  const decorationNote = el('span', 'Decorative activity · zero AI tokens', 'brain-network-decoration-note');
  const inspector = el('aside', undefined, 'brain-network-inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', 'Selected network region');
  stage.append(grid, canvas, labels, coordinate, mode, controls, hint, decorationNote); shell.append(stage, inspector); host.replaceChildren(shell);

  function closeInspector({ restoreFocus = false } = {}) {
    const previous = selectedId; selectedId = null; inspector.hidden = true; inspector.replaceChildren();
    for (const item of lobeButtons.values()) item.setAttribute('aria-pressed', 'false');
    if (restoreFocus) lobeButtons.get(previous)?.focus({ preventScroll: true });
    draw();
  }
  function renderInspector() {
    const node = data.nodes.find((item) => item.id === selectedId);
    if (!node) { closeInspector(); return; }
    const focusedAction = inspector.contains(document.activeElement) ? document.activeElement.dataset.networkNavigate || document.activeElement.dataset.networkClose : null;
    inspector.hidden = false;
    const close = button('×', 'brain-network-inspector-close', 'Close region details'); close.dataset.networkClose = 'close';
    const badge = el('div', node.kind === 'agent' ? 'AGENT ROLE' : 'SUPPORT MODULE', 'brain-network-inspector-meta');
    const status = el('span', label(node.status), 'brain-network-state'); status.dataset.active = String(active(node.status));
    inspector.replaceChildren(close, badge, el('h2', node.name), status, el('p', node.detail));
    if (node.provider) inspector.append(el('p', node.provider, 'brain-network-inspector-note'));
    if (node.kind === 'agent') {
      const events = safeArray(data.run?.trace).filter((event) => event.agent === node.role);
      if (events.length) inspector.append(el('p', events.at(-1).summary || 'Saved mission activity is available in Research.', 'brain-network-inspector-note'));
    }
    if (node.id === 'module:robinhood') inspector.append(el('p', !data.brokerState ? 'Open Accounts to check your connection and review queue.' : data.brokerState.connected ? 'Your account connection is saved. Every trading action requires its own review.' : 'Add your Robinhood connection in Settings.', 'brain-network-inspector-note'));
    const actionLabel = node.panel === 'robinhood' ? 'Open Accounts ↗' : node.panel === 'knowledge' ? 'Open Knowledge ↗' : node.panel === 'checks' ? 'Open Settings ↗' : 'Open Research ↗';
    const navigate = button(actionLabel, 'brain-network-open'); navigate.dataset.networkNavigate = node.panel ?? 'mission'; inspector.append(navigate);
    for (const [id, item] of lobeButtons) item.setAttribute('aria-pressed', String(id === selectedId));
    if (focusedAction) (focusedAction === 'close' ? close : navigate).focus({ preventScroll: true });
  }
  function renderNodes() {
    for (const node of data.nodes.filter((item) => item.region)) {
      const item = lobeButtons.get(node.id) ?? button(undefined, 'brain-network-lobe');
      item.dataset.lobeNode = node.id; item.dataset.networkNode = node.id;
      item.setAttribute('aria-label', `Inspect ${node.name} ${node.kind === 'agent' ? 'agent' : 'support module'}`);
      item.setAttribute('aria-pressed', String(node.id === selectedId)); item.dataset.active = String(active(node.status));
      if (!item.firstChild) item.append(el('span', '', 'brain-network-lobe-dot'), el('strong', node.name));
      lobeButtons.set(node.id, item); if (!labels.contains(item)) labels.append(item);
    }
  }
  function draw() {
    if (disposed) return;
    const selected = data.nodes.find((node) => node.id === selectedId);
    const anchors = renderCanvas?.({ width, height, ...view, time: sceneTime, selectedRegion: selected?.region });
    const regions = [];
    for (const [index, [id, item]] of [...lobeButtons].entries()) {
      const node = data.nodes.find((entry) => entry.id === id);
      const fallbackAngle = index * Math.PI / 4;
      const point = anchors?.get(node.region) ?? { x: width * (.5 + Math.cos(fallbackAngle) * .25), y: height * (.47 + Math.sin(fallbackAngle) * .27) };
      regions.push({ item, point, node });
    }
    // Keep four labels on each side even when panning every cluster off-center.
    regions.sort((a, b) => a.point.x - b.point.x);
    const sides = { left: regions.slice(0, 4), right: regions.slice(4) };
    const labelWidth = Math.min(126, width * .30), labelHeight = 40;
    for (const [side, entries] of Object.entries(sides)) {
      entries.sort((a, b) => a.point.y - b.point.y);
      const minY = 85, maxY = Math.max(minY, height - 130 - labelHeight);
      const gap = Math.min(54, (maxY - minY) / Math.max(1, entries.length - 1)), span = gap * (entries.length - 1);
      const start = Math.max(minY, Math.min(maxY - span, height * .46 - span / 2));
      entries.forEach(({ item, point, node }, index) => {
        const y = start + index * gap, x = side === 'left' ? Math.max(14, width * .065 - labelWidth / 3) : Math.min(width - labelWidth - 14, width * .935 - labelWidth * .67);
        item.style.left = `${x}px`; item.style.top = `${y}px`; item.style.width = `${labelWidth}px`;
        if (context) {
          const endpoint = side === 'left' ? x + labelWidth : x;
          context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(endpoint, y + labelHeight / 2);
          context.strokeStyle = node.id === selectedId ? canvasColors.red || '#ff2e43' : canvasColors.line || '#493039';
          context.globalAlpha = node.id === selectedId ? .7 : .27; context.lineWidth = .7; context.stroke(); context.globalAlpha = 1;
          context.fillStyle = canvasColors.red || '#ff2e43'; context.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
        }
      });
    }
  }
  function visibleStage() { return !document.hidden && intersecting && !stage.closest('[hidden]') && width > 0; }
  function animate(time) {
    frame = null;
    if (disposed || paused || !context || !visibleStage()) { stopAnimation(); return; }
    if (lastPaint === null || time - lastPaint >= 1000 / 30) {
      if (lastFrameTime !== null) sceneTime += Math.min(100, Math.max(0, time - lastFrameTime));
      lastFrameTime = time; draw(); lastPaint = time;
    }
    frame = window.requestAnimationFrame(animate);
  }
  function startAnimation() {
    const running = !disposed && !paused && visibleStage(); shell.dataset.motion = running ? 'running' : 'paused';
    if (frame === null && running && context && window?.requestAnimationFrame) frame = window.requestAnimationFrame(animate);
  }
  function stopAnimation() { if (frame !== null) window?.cancelAnimationFrame?.(frame); frame = null; lastFrameTime = null; lastPaint = null; shell.dataset.motion = 'paused'; }
  function refresh() {
    if (disposed) return;
    const rect = stage.getBoundingClientRect(); width = rect.width || stage.clientWidth || 1000; height = rect.height || stage.clientHeight || 700;
    const ratio = Math.min(window?.devicePixelRatio || 1, 2); canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(); startAnimation();
  }
  function setMotion(value) { paused = value; motion.textContent = paused ? '▷' : 'Ⅱ'; motion.setAttribute('aria-label', paused ? 'Resume network motion' : 'Pause network motion'); motion.setAttribute('aria-pressed', String(paused)); paused ? stopAnimation() : startAnimation(); draw(); }
  function setZoom(value) { view.zoom = Math.min(1.65, Math.max(.65, value)); zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`; zoomIn.disabled = view.zoom >= 1.65; zoomOut.disabled = view.zoom <= .65; draw(); }
  function select(id) { if (!data.nodes.some((node) => node.id === id && node.region)) return; selectedId = id; renderInspector(); draw(); }
  listen(labels, 'click', (event) => { const item = event.target.closest('[data-lobe-node]'); if (item) select(item.dataset.lobeNode); });
  listen(inspector, 'click', (event) => {
    if (event.target.closest('[data-network-close]')) { closeInspector({ restoreFocus: true }); return; }
    const item = event.target.closest('[data-network-navigate]');
    if (item && ['mission', 'knowledge', 'checks', 'network', 'robinhood'].includes(item.dataset.networkNavigate)) onNavigate(item.dataset.networkNavigate);
  });
  listen(shell, 'keydown', (event) => { if (event.key === 'Escape' && selectedId) { event.preventDefault(); closeInspector({ restoreFocus: true }); } });
  const setMoveMode = (value) => { moveMode = value; move.setAttribute('aria-pressed', String(value)); rotate.setAttribute('aria-pressed', String(!value)); hint.textContent = value ? 'Drag to move · Select a region to explore' : 'Drag to rotate · Shift-drag to move · Select a region'; };
  listen(move, 'click', () => setMoveMode(true)); listen(rotate, 'click', () => setMoveMode(false));
  listen(zoomOut, 'click', () => setZoom(view.zoom - .1)); listen(zoomIn, 'click', () => setZoom(view.zoom + .1));
  listen(reset, 'click', () => { Object.assign(view, defaultView()); setZoom(1); }); listen(motion, 'click', () => setMotion(!paused));
  const clampPan = (value) => Math.max(-.36, Math.min(.36, value));
  listen(stage, 'pointerdown', (event) => {
    if (drag || event.button !== 0 || event.target.closest('button')) return;
    drag = { x: event.clientX, y: event.clientY, ...view, id: event.pointerId, move: moveMode || event.shiftKey, moved: false };
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* Synthetic events may lack a pointer id. */ }
    stage.classList.add('brain-network-dragging');
  });
  listen(stage, 'pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.moved ||= Math.abs(dx) + Math.abs(dy) >= 5;
    if (!drag.moved) return;
    if (drag.move) { view.panX = clampPan(drag.panX + dx / width); view.panY = clampPan(drag.panY + dy / height); }
    else { view.yaw = drag.yaw + dx * .008; view.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch + dy * .008)); }
    draw();
  });
  const endDrag = () => {
    const previous = drag; drag = null; stage.classList.remove('brain-network-dragging');
    if (previous) { try { stage.releasePointerCapture?.(previous.id); } catch { /* Capture may already have ended. */ } }
  };
  listen(stage, 'pointerup', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      const rect = stage.getBoundingClientRect(), region = renderCanvas?.hitTest(event.clientX - rect.left, event.clientY - rect.top), node = data.nodes.find((item) => item.region === region);
      if (node) select(node.id); else closeInspector();
    }
    endDrag();
  });
  listen(stage, 'pointercancel', endDrag); listen(stage, 'lostpointercapture', endDrag); listen(window, 'blur', endDrag);
  listen(stage, 'keydown', (event) => {
    if (event.target !== stage) return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key]) {
      const [x, y] = arrows[event.key];
      if (event.shiftKey || moveMode) { view.panX = clampPan(view.panX + x * .03); view.panY = clampPan(view.panY + y * .03); }
      else { view.yaw += x * .12; view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + y * .1)); }
    } else if (['+', '='].includes(event.key)) setZoom(view.zoom + .1);
    else if (event.key === '-') setZoom(view.zoom - .1);
    else return;
    event.preventDefault(); draw();
  });
  listen(document, 'visibilitychange', () => { if (document.hidden) { endDrag(); stopAnimation(); } else startAnimation(); });
  listen(window, 'resize', refresh); listen(motionQuery, 'change', (event) => setMotion(event.matches));
  listen(document, 'synergy-module:themechange', () => { canvasColors = palette(); renderCanvas?.setColors(canvasColors); draw(); });
  const resizeObserver = typeof window?.ResizeObserver === 'function' ? new window.ResizeObserver(refresh) : null; resizeObserver?.observe(stage);
  const intersectionObserver = typeof window?.IntersectionObserver === 'function' ? new window.IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); if (intersecting) refresh(); else stopAnimation(); }) : null; intersectionObserver?.observe(stage);
  function update(state = {}) {
    if (disposed) return;
    data = buildBrainNetworkData(state);
    mode.textContent = data.run ? `${data.run.input?.mode === 'demo' ? 'DEMO' : 'RESEARCH'} / ${label(data.run.status).toUpperCase()}` : 'IDLE';
    renderNodes(); if (selectedId) renderInspector(); refresh();
  }
  update(); setZoom(view.zoom); setMotion(paused);
  return { update, refresh, dispose() { if (disposed) return; disposed = true; stopAnimation(); endDrag(); resizeObserver?.disconnect(); intersectionObserver?.disconnect(); for (const remove of listeners) remove(); lobeButtons.clear(); } };
}
