import { createBrainNetworkRenderer, BRAIN_REGION_CENTERS } from "./brain-network-renderer.js";
import { defaultBrainView, copyBrainView, rotateView, focusBrainView, interpolateBrainView, clampBrainZoom, MIN_BRAIN_ZOOM, MAX_BRAIN_ZOOM } from './brain-camera.js';

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

export function createBrainNetwork(host, { onNavigate = () => {}, onManageTools = () => {} } = {}) {
  if (!host?.ownerDocument) return { update() {}, refresh() {}, dispose() {} };
  const document = host.ownerDocument, window = document.defaultView;
  const view = documentViews.get(document) ?? defaultBrainView(); documentViews.set(document, view);
  const el = (tag, text, className) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; };
  const button = (text, className, ariaLabel) => { const item = el('button', text, className); item.type = 'button'; if (ariaLabel) item.setAttribute('aria-label', ariaLabel); return item; };
  let data = buildBrainNetworkData(), canManageTools = false, selectedId = null, disposed = false, frame = null, lastPaint = null, lastFrameTime = null, sceneTime = 0;
  let width = 1000, height = 700, drag = null, intersecting = true, moveMode = false, transition = null;
  const motionQuery = window?.matchMedia?.('(prefers-reduced-motion: reduce)');
  const narrowQuery = window?.matchMedia?.('(max-width: 760px)');
  let reducedMotion = Boolean(motionQuery?.matches), paused = reducedMotion;
  const listeners = [], lobeButtons = new Map();
  const listen = (target, event, handler, options) => { target?.addEventListener?.(event, handler, options); listeners.push(() => target?.removeEventListener?.(event, handler, options)); };
  const shell = el('section', undefined, 'brain-network-shell'); shell.setAttribute('aria-label', 'Interactive neural network');
  const rail = el('aside', undefined, 'brain-network-rail'); rail.setAttribute('aria-label', 'Brain sections');
  const railHeader = el('div', undefined, 'brain-network-rail-header');
  const railClose = button('×', 'brain-network-rail-close', 'Close brain sections');
  railHeader.append(el('h1', 'Brain'), railClose, el('p', 'Select a section to bring it into view.'));
  const overview = button('Whole brain', 'brain-network-overview', 'Show whole brain'); overview.setAttribute('aria-pressed', 'true');
  const groups = new Map();
  rail.append(railHeader, overview);
  for (const [kind, name] of [['agent', 'Agents'], ['module', 'Modules']]) {
    const group = el('div', undefined, 'brain-network-group'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', name);
    group.append(el('h2', name)); groups.set(kind, group); rail.append(group);
  }
  const manageTools = button('Tools · Admin', 'brain-network-overview', 'Manage brain tools'); manageTools.hidden = true; rail.append(manageTools);
  listen(manageTools, 'click', () => { if (canManageTools) onManageTools(selectedId ?? 'agent:researcher'); });
  const stage = el('div', undefined, 'brain-network-stage'); stage.tabIndex = 0;
  stage.setAttribute('aria-label', 'Neural network. Drag to rotate freely in any direction. Scroll to zoom. Shift-drag to move. Arrow keys rotate, Shift-arrow keys move, plus and minus zoom.');
  const canvas = el('canvas', undefined, 'brain-network-canvas'); canvas.setAttribute('aria-hidden', 'true');
  let context = null;
  if (typeof window?.CanvasRenderingContext2D === 'function') { try { context = canvas.getContext('2d', { alpha: true }); } catch { /* Labels remain available without canvas. */ } }
  const palette = () => { const theme = window?.getComputedStyle?.(host); return { red: theme?.getPropertyValue('--red').trim(), glow: theme?.getPropertyValue('--red-glow').trim(), line: theme?.getPropertyValue('--line-strong').trim(), mono: theme?.getPropertyValue('--font-mono').trim(), dark: document.documentElement.dataset.theme !== 'daylight' }; };
  let canvasColors = palette();
  const renderCanvas = context ? createBrainNetworkRenderer(context, canvasColors) : null;
  const grid = el('div', undefined, 'brain-network-grid'); grid.setAttribute('aria-hidden', 'true');
  const coordinate = el('span', 'SYNERGY MODULE / NEURAL NETWORK', 'brain-network-coordinate');
  const targetLabel = el('span', '', 'brain-network-target'); targetLabel.hidden = true;
  const sectionsToggle = button('Sections', 'brain-network-sections-toggle', 'Open brain sections'); sectionsToggle.setAttribute('aria-expanded', 'false');
  const liveStatus = el('span', '', 'brain-network-announcement'); liveStatus.setAttribute('role', 'status');
  const mode = el('span', 'IDLE', 'brain-network-mode');
  const controls = el('div', undefined, 'brain-network-controls'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Network view controls');
  const rotate = button('Rotate', undefined, 'Rotate network'), move = button('Move', undefined, 'Move network');
  const zoomOut = button('−', undefined, 'Zoom out'), zoomIn = button('+', undefined, 'Zoom in');
  const reset = button('↺', undefined, 'Reset network view'), motion = button(paused ? '▷' : 'Ⅱ', undefined, 'Pause network motion');
  const zoomLabel = el('output', `${Math.round(view.zoom * 100)}%`, 'brain-network-zoom'); zoomLabel.setAttribute('aria-label', 'Network zoom');
  rotate.setAttribute('aria-pressed', 'true'); move.setAttribute('aria-pressed', 'false');
  controls.append(rotate, move, zoomOut, zoomLabel, zoomIn, reset, motion);
  const hint = el('span', 'Drag to rotate freely · Scroll to zoom · Shift-drag to move', 'brain-network-hint');
  const decorationNote = el('span', 'Decorative activity · zero AI tokens', 'brain-network-decoration-note');
  const inspector = el('aside', undefined, 'brain-network-inspector'); inspector.hidden = true; inspector.setAttribute('aria-label', 'Selected network region');
  stage.append(grid, canvas, targetLabel, coordinate, mode, sectionsToggle, controls, hint, decorationNote, inspector, liveStatus);
  shell.append(rail, stage); host.replaceChildren(shell);

  function setSectionsOpen(open, { restoreFocus = false } = {}) {
    shell.dataset.sectionsOpen = String(open);
    sectionsToggle.setAttribute('aria-expanded', String(open));
    rail.toggleAttribute('inert', Boolean(narrowQuery?.matches && !open));
    if (restoreFocus) sectionsToggle.focus({ preventScroll: true });
  }

  function closeInspector({ restoreFocus = false } = {}) {
    const previous = selectedId; selectedId = null; inspector.hidden = true; inspector.replaceChildren();
    cancelTransition(); targetLabel.hidden = true; overview.setAttribute('aria-pressed', 'true');
    for (const item of lobeButtons.values()) item.setAttribute('aria-pressed', 'false');
    if (restoreFocus) (narrowQuery?.matches ? sectionsToggle : lobeButtons.get(previous))?.focus({ preventScroll: true });
    draw();
  }
  function renderInspector() {
    const node = data.nodes.find((item) => item.id === selectedId);
    if (!node) { closeInspector(); return; }
    const focusedAction = inspector.contains(document.activeElement) ? document.activeElement.dataset.networkNavigate || document.activeElement.dataset.networkClose : null;
    inspector.hidden = false;
    overview.setAttribute('aria-pressed', 'false');
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
    if (canManageTools) { const access = button('Manage tool access ↗', 'brain-network-open'); access.dataset.networkTools = node.id; inspector.append(access); }
    for (const [id, item] of lobeButtons) item.setAttribute('aria-pressed', String(id === selectedId));
    if (focusedAction) (focusedAction === 'close' ? close : navigate).focus({ preventScroll: true });
  }
  function renderNodes() {
    for (const node of data.nodes.filter((item) => item.region)) {
      const item = lobeButtons.get(node.id) ?? button(undefined, 'brain-network-lobe');
      item.dataset.lobeNode = node.id; item.dataset.networkNode = node.id;
      item.setAttribute('aria-label', `Inspect ${node.name} ${node.kind === 'agent' ? 'agent' : 'support module'}`);
      item.setAttribute('aria-pressed', String(node.id === selectedId)); item.dataset.active = String(active(node.status));
      if (!item.firstChild) item.append(el('span', '', 'brain-network-lobe-dot'), el('strong', node.name), el('small', '', 'brain-network-lobe-status'));
      item.querySelector('small').textContent = label(node.status);
      lobeButtons.set(node.id, item); if (!rail.contains(item)) groups.get(node.kind).append(item);
    }
  }
  function draw() {
    if (disposed) return;
    const selected = data.nodes.find((node) => node.id === selectedId);
    const anchors = renderCanvas?.({ width, height, ...view, time: sceneTime, selectedRegion: selected?.region });
    const point = selected && anchors?.get(selected.region);
    targetLabel.hidden = !point || point.x < 0 || point.x > width || point.y < 55 || point.y > height - 120;
    if (point) {
      targetLabel.textContent = selected.name;
      targetLabel.style.left = `${Math.max(70, Math.min(width - 70, point.x))}px`;
      targetLabel.style.top = `${point.y - 30}px`;
    }
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    zoomIn.disabled = view.zoom >= MAX_BRAIN_ZOOM; zoomOut.disabled = view.zoom <= MIN_BRAIN_ZOOM;
  }
  function visibleStage() { return !document.hidden && intersecting && !stage.closest('[hidden]') && width > 0; }
  function cancelTransition() {
    transition = null; shell.dataset.camera = 'manual';
    if (paused) stopAnimation();
  }
  function transitionTo(target, kind = 'focus', duration = 850) {
    transition = { from: copyBrainView(view), to: copyBrainView(target), kind, elapsed: 0, duration };
    shell.dataset.camera = kind === 'focus' ? 'focusing' : kind;
    if (reducedMotion || !context || !window?.requestAnimationFrame) {
      Object.assign(view, copyBrainView(target)); transition = null;
      shell.dataset.camera = selectedId ? 'focused' : 'overview'; draw();
    } else startAnimation();
  }
  function animate(time) {
    frame = null;
    if (disposed || (paused && !transition) || !context || !visibleStage()) { stopAnimation(); return; }
    if (lastPaint === null || transition || time - lastPaint >= 1000 / 30) {
      const delta = lastFrameTime === null ? 0 : Math.min(100, Math.max(0, time - lastFrameTime));
      if (!paused) sceneTime += delta;
      if (transition) {
        transition.elapsed += delta;
        const progress = Math.min(1, transition.elapsed / transition.duration);
        Object.assign(view, interpolateBrainView(transition.from, transition.to, progress));
        if (progress === 1) {
          transition = null; shell.dataset.camera = selectedId ? 'focused' : 'overview';
          liveStatus.textContent = selectedId ? `${data.nodes.find((node) => node.id === selectedId)?.name} in view.` : 'Whole brain in view.';
        }
      }
      lastFrameTime = time; draw(); lastPaint = time;
    }
    if (!paused || transition) frame = window.requestAnimationFrame(animate); else stopAnimation();
  }
  function startAnimation() {
    const visible = !disposed && visibleStage(); shell.dataset.motion = visible && !paused ? 'running' : 'paused';
    if (frame === null && visible && (!paused || transition) && context && window?.requestAnimationFrame) frame = window.requestAnimationFrame(animate);
  }
  function stopAnimation() { if (frame !== null) window?.cancelAnimationFrame?.(frame); frame = null; lastFrameTime = null; lastPaint = null; shell.dataset.motion = 'paused'; }
  function refresh() {
    if (disposed) return;
    const rect = stage.getBoundingClientRect(); width = rect.width || stage.clientWidth || 1000; height = rect.height || stage.clientHeight || 700;
    const ratio = Math.min(window?.devicePixelRatio || 1, 2); canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context?.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(); startAnimation();
  }
  function setMotion(value) { paused = value; motion.textContent = paused ? '▷' : 'Ⅱ'; motion.setAttribute('aria-label', paused ? 'Resume network motion' : 'Pause network motion'); motion.setAttribute('aria-pressed', String(paused)); paused && !transition ? stopAnimation() : startAnimation(); draw(); }
  function setZoom(value, { smooth = false } = {}) {
    const zoom = clampBrainZoom(value); cancelTransition();
    if (smooth) transitionTo({ ...copyBrainView(view), zoom }, 'zooming', 180);
    else { view.zoom = zoom; draw(); }
  }
  function select(id) {
    const node = data.nodes.find((node) => node.id === id && node.region); if (!node) return;
    endDrag(); selectedId = id; renderInspector();
    if (narrowQuery?.matches) setSectionsOpen(false, { restoreFocus: true });
    liveStatus.textContent = `Selected ${node.name}.`;
    transitionTo(focusBrainView(view, BRAIN_REGION_CENTERS[node.region], width)); draw();
  }
  function showWholeBrain() { endDrag(); closeInspector(); transitionTo(defaultBrainView(), 'overview'); }
  listen(rail, 'click', (event) => { const item = event.target.closest('[data-lobe-node]'); if (item) select(item.dataset.lobeNode); });
  listen(overview, 'click', () => { showWholeBrain(); if (narrowQuery?.matches) setSectionsOpen(false, { restoreFocus: true }); });
  listen(sectionsToggle, 'click', () => { setSectionsOpen(true); (lobeButtons.get(selectedId) ?? overview).focus({ preventScroll: true }); });
  listen(railClose, 'click', () => setSectionsOpen(false, { restoreFocus: true }));
  listen(inspector, 'click', (event) => {
    const toolButton = event.target.closest('[data-network-tools]');
    if (toolButton && canManageTools) { onManageTools(toolButton.dataset.networkTools); return; }
    if (event.target.closest('[data-network-close]')) { closeInspector({ restoreFocus: true }); return; }
    const item = event.target.closest('[data-network-navigate]');
    if (item && ['mission', 'knowledge', 'checks', 'network', 'robinhood'].includes(item.dataset.networkNavigate)) onNavigate(item.dataset.networkNavigate);
  });
  listen(shell, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (narrowQuery?.matches && shell.dataset.sectionsOpen === 'true') { event.preventDefault(); setSectionsOpen(false, { restoreFocus: true }); }
    else if (selectedId) { event.preventDefault(); closeInspector({ restoreFocus: !narrowQuery?.matches }); if (narrowQuery?.matches) sectionsToggle.focus({ preventScroll: true }); }
  });
  const setMoveMode = (value) => { moveMode = value; move.setAttribute('aria-pressed', String(value)); rotate.setAttribute('aria-pressed', String(!value)); hint.textContent = value ? 'Drag to move · Scroll to zoom · Select a section to focus' : 'Drag to rotate freely · Scroll to zoom · Shift-drag to move'; };
  listen(move, 'click', () => setMoveMode(true)); listen(rotate, 'click', () => setMoveMode(false));
  listen(zoomOut, 'click', () => setZoom(view.zoom - .1)); listen(zoomIn, 'click', () => setZoom(view.zoom + .1));
  listen(reset, 'click', showWholeBrain); listen(motion, 'click', () => setMotion(!paused));
  const clampPan = (value) => Math.max(-.65, Math.min(.65, value));
  listen(stage, 'wheel', (event) => {
    if (event.target.closest('.brain-network-controls, .brain-network-inspector, .brain-network-sections-toggle')) return;
    event.preventDefault(); endDrag();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1;
    const delta = Math.max(-250, Math.min(250, event.deltaY * unit));
    const zoom = transition?.kind === 'zooming' ? transition.to.zoom : view.zoom;
    setZoom(zoom * Math.exp(-delta * .0015), { smooth: true });
  }, { passive: false });
  listen(stage, 'pointerdown', (event) => {
    if (drag || ![0, 1].includes(event.button) || event.target.closest('button, .brain-network-inspector, .brain-network-controls')) return;
    event.preventDefault(); cancelTransition(); stage.focus({ preventScroll: true });
    drag = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, ...copyBrainView(view), id: event.pointerId, move: moveMode || event.shiftKey || event.button === 1, moved: false };
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* Synthetic events may lack a pointer id. */ }
    stage.classList.add('brain-network-dragging');
  });
  listen(stage, 'pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    drag.moved ||= Math.abs(dx) + Math.abs(dy) >= 5;
    if (!drag.moved) return;
    if (drag.move) { view.panX = clampPan(drag.panX + dx / width); view.panY = clampPan(drag.panY + dy / height); }
    else view.orientation = rotateView(view.orientation, (event.clientX - drag.lastX) * .008, (event.clientY - drag.lastY) * .008);
    drag.lastX = event.clientX; drag.lastY = event.clientY;
    draw();
  });
  function endDrag() {
    const previous = drag; drag = null; stage.classList.remove('brain-network-dragging');
    if (previous) { try { stage.releasePointerCapture?.(previous.id); } catch { /* Capture may already have ended. */ } }
  }
  listen(stage, 'pointerup', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const clicked = !drag.moved; endDrag();
    if (clicked) {
      const rect = stage.getBoundingClientRect(), region = renderCanvas?.hitTest(event.clientX - rect.left, event.clientY - rect.top), node = data.nodes.find((item) => item.region === region);
      if (node) select(node.id); else closeInspector();
    }
  });
  const cancelGesture = (event) => { if (event.pointerId === undefined || event.pointerId === drag?.id) endDrag(); };
  listen(stage, 'pointercancel', cancelGesture); listen(stage, 'lostpointercapture', cancelGesture); listen(window, 'blur', endDrag);
  listen(stage, 'keydown', (event) => {
    if (event.target !== stage) return;
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[event.key]) {
      cancelTransition();
      const [x, y] = arrows[event.key];
      if (event.shiftKey || moveMode) { view.panX = clampPan(view.panX + x * .03); view.panY = clampPan(view.panY + y * .03); }
      else view.orientation = rotateView(view.orientation, x * .12, y * .1);
    } else if (['+', '='].includes(event.key)) setZoom(view.zoom + .1);
    else if (event.key === '-') setZoom(view.zoom - .1);
    else if (event.key === 'Home') showWholeBrain();
    else return;
    event.preventDefault(); draw();
  });
  listen(document, 'visibilitychange', () => { if (document.hidden) { endDrag(); stopAnimation(); } else startAnimation(); });
  listen(window, 'resize', refresh);
  listen(motionQuery, 'change', (event) => {
    reducedMotion = event.matches;
    if (reducedMotion && transition) { Object.assign(view, copyBrainView(transition.to)); transition = null; shell.dataset.camera = selectedId ? 'focused' : 'overview'; }
    setMotion(event.matches);
  });
  listen(narrowQuery, 'change', () => { setSectionsOpen(false); refresh(); });
  listen(document, 'synergy-module:themechange', () => { canvasColors = palette(); renderCanvas?.setColors(canvasColors); draw(); });
  const resizeObserver = typeof window?.ResizeObserver === 'function' ? new window.ResizeObserver(refresh) : null; resizeObserver?.observe(stage);
  const intersectionObserver = typeof window?.IntersectionObserver === 'function' ? new window.IntersectionObserver((entries) => { intersecting = entries.some((entry) => entry.isIntersecting); if (intersecting) refresh(); else stopAnimation(); }) : null; intersectionObserver?.observe(stage);
  function update(state = {}) {
    if (disposed) return;
    data = buildBrainNetworkData(state);
    canManageTools = state.canManageTools === true; manageTools.hidden = !canManageTools;
    mode.textContent = data.run ? `${data.run.input?.mode === 'demo' ? 'DEMO' : 'RESEARCH'} / ${label(data.run.status).toUpperCase()}` : 'IDLE';
    renderNodes(); if (selectedId) renderInspector(); refresh();
  }
  setSectionsOpen(false); update(); setZoom(view.zoom); setMotion(paused);
  return { update, refresh, dispose() { if (disposed) return; disposed = true; stopAnimation(); endDrag(); resizeObserver?.disconnect(); intersectionObserver?.disconnect(); for (const remove of listeners) remove(); lobeButtons.clear(); } };
}
