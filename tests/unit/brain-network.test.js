import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildBrainNetworkData, createBrainNetwork } from "../../public/js/brain/brain-network.js";
import { buildMatrixBrain, BRAIN_REGIONS } from "../../public/js/brain/brain-network-renderer.js";

const tools = ["context.read", "knowledge.search", "memory.search", "journal.search", "calendar.read", "risk.check"].map((name) => ({ name, description: `${name} description` }));
const run = { id: "r1", status: "completed", input: { symbol: "ES", mode: "demo", provider: "gemini", objective: "Review the supplied market context" },
  graph: { nodes: [{ role: "researcher", status: "complete" }] }, trace: [{ at: "2026-09-14T12:00:00Z", agent: "researcher", type: "tool", summary: "Read the market snapshot", details: { tool: "context.read" } }] };
const state = { defaultProvider: "gemini", paidCallsEnabled: false, providers: [{ id: "gemini", label: "Gemini", model: "test-model" }], runs: [run], selectedRun: run, toolDefinitions: tools, documents: [{ id: "d1", kind: "memory", title: "Reviewed ES lesson", characters: 87 }] };

function fixture(t, options = {}, beforeCreate = () => {}) {
  const dom = new JSDOM('<div data-network-host></div>'); const host = dom.window.document.querySelector("[data-network-host]"); beforeCreate(dom.window);
  const instance = createBrainNetwork(host, options); t.after(() => { instance.dispose(); dom.window.close(); });
  return { dom, host, instance, find: (selector) => host.querySelector(selector) };
}

function canvasHarness({ reducedMotion = false } = {}) {
  const frames = new Map(), disconnected = []; let next = 0, paints = 0, operations = [], intersection, hidden = false, motionChange;
  const context = {
    clearRect() { paints += 1; operations = []; },
    setTransform() {}, createRadialGradient() { return { addColorStop() {} }; },
  };
  for (const name of ["fillStyle", "globalCompositeOperation"]) Object.defineProperty(context, name, { set(value) { operations.push([name, value]); } });
  for (const name of ["fillRect", "fillText", "beginPath", "moveTo", "lineTo", "quadraticCurveTo", "stroke", "arc", "ellipse"]) {
    context[name] = (...args) => operations.push([name, ...args]);
  }
  return {
    frames, disconnected, get paints() { return paints; }, snapshot: () => JSON.stringify(operations),
    glyphs: () => operations.filter(([name, text]) => name === "fillText" && /^[01]$/.test(text)),
    lobeAnchors: () => operations.filter(([name, , , width, height]) => name === "fillRect" && width === 3 && height === 3).map(([, x, y]) => [x, y]),
    install(window) {
      window.CanvasRenderingContext2D = function () {};
      window.HTMLCanvasElement.prototype.getContext = () => context;
      window.requestAnimationFrame = (callback) => { frames.set(++next, callback); return next; };
      window.cancelAnimationFrame = (id) => frames.delete(id);
      window.ResizeObserver = class { observe() {} disconnect() { disconnected.push("resize"); } };
      window.IntersectionObserver = class { constructor(callback) { intersection = callback; } observe() {} disconnect() { disconnected.push("intersection"); } };
      window.matchMedia = (query) => ({ matches: query.includes('reduced-motion') && reducedMotion, addEventListener(type, callback) { if (query.includes('reduced-motion')) motionChange = callback; }, removeEventListener() { if (query.includes('reduced-motion')) motionChange = null; } });
      Object.defineProperty(window.document, "hidden", { get: () => hidden, configurable: true });
    },
    step(time) {
      assert.equal(frames.size, 1, "one animation frame should be scheduled");
      const [id, callback] = frames.entries().next().value; frames.delete(id); callback(time);
    },
    setIntersection(value) { intersection([{ isIntersecting: value }]); },
    setHidden(window, value) { hidden = value; window.document.dispatchEvent(new window.Event("visibilitychange")); },
    setReducedMotion(value) { motionChange?.({ matches: value }); },
  };
}

test("network reports actual saved counts and bounded source nodes without fabricated usage", () => {
  const documents = Array.from({ length: 14 }, (_, index) => ({ id: `d${index}`, title: `Source ${index}`, kind: index < 3 ? "memory" : "knowledge", characters: index + 1 }));
  const data = buildBrainNetworkData({ ...state, documents });
  assert.deepEqual(data.counts, { agents: 4, tools: 6, documents: 14, memories: 3, runs: 1 });
  assert.equal(data.nodes.filter((node) => node.kind === "memory").length, 6);
  assert.equal(data.nodes.filter((node) => node.kind === "run").length, 1);
  assert.equal(data.nodes.find((node) => node.id === "tool:context.read").observations, 1);
  assert.equal(Object.hasOwn(data.counts, "tokens"), false);
  assert.equal(buildBrainNetworkData().counts.tools, 0);
  assert.equal(buildBrainNetworkData().counts.runs, 0);
});

test("tool connections follow the most recent valid recorded agent", () => {
  const selectedRun = { ...run, trace: [
    { agent: "researcher", details: { tool: "context.read" } },
    { agent: "critic", details: { tool: "context.read" } },
    { agent: "unknown", details: { tool: "context.read" } },
  ] };
  const data = buildBrainNetworkData({ ...state, selectedRun });
  assert.equal(data.nodes.find((node) => node.id === "tool:context.read").parent, "agent:critic");
  assert.equal(data.nodes.find((node) => node.id === "tool:calendar.read").parent, "agent:researcher");
  assert.equal(data.nodes.find((node) => node.id === "tool:risk.check").parent, "agent:strategist");
});

test("planner status follows validated plan evidence and stopped runs never show active roles", () => {
  const planner = (selectedRun) => buildBrainNetworkData({ selectedRun }).nodes.find((node) => node.id === "agent:planner");
  assert.equal(planner({ status: "running", trace: [{ agent: "planner", type: "step" }] }).status, "running");
  assert.equal(planner({ status: "awaiting_approval", trace: [{ agent: "planner", type: "plan" }] }).status, "complete");
  assert.equal(planner({ status: "completed", plan: [{ role: "researcher" }], trace: [] }).status, "complete");
  assert.equal(planner({ status: "failed", trace: [{ agent: "planner", type: "step" }] }).status, "failed");
  assert.equal(planner({ status: "completed" }).status, "idle", "no evidence cannot imply planning completed");
  const stopped = buildBrainNetworkData({ selectedRun: { status: "cancelled", graph: { nodes: [{ role: "researcher", status: "running" }] } } });
  assert.equal(stopped.nodes.find((node) => node.id === "agent:researcher").status, "cancelled");
});

test("provider routes use saved mission overrides before the selected default", () => {
  const providers = [{ id: "claude", label: "Claude", model: "c-test" }, ...state.providers];
  const initial = buildBrainNetworkData({ providers, defaultProvider: "claude" });
  assert.match(initial.nodes.find((node) => node.id === "agent:planner").provider, /Claude.*default route/);
  const selectedRun = { ...run, input: { ...run.input, mode: "analysis", routes: { planner: "claude" } } };
  const routed = buildBrainNetworkData({ ...state, providers, selectedRun });
  assert.match(routed.nodes.find((node) => node.id === "agent:planner").provider, /Claude/);
  assert.match(routed.nodes.find((node) => node.id === "agent:researcher").provider, /Gemini/);
  assert.match(buildBrainNetworkData(state).nodes.find((node) => node.id === "agent:planner").provider, /Offline demo · no model calls/);
  const missingModel = buildBrainNetworkData({ providers: [{ id: "gemini", label: "Gemini", model: "" }], defaultProvider: "gemini" });
  assert.equal(missingModel.nodes.find((node) => node.id === "agent:planner").provider, "Gemini · Not configured · default route");
});

test('the default canvas shows eight accessible regions without dashboard clutter', (t) => {
  const app = fixture(t); app.instance.update(state);
  assert.equal(app.find('canvas').getAttribute('aria-hidden'), 'true');
  assert.equal(app.host.querySelectorAll('[data-lobe-node]').length, 8);
  assert.equal(app.find('.brain-network-inspector').hidden, true);
  for (const removed of ['roster', 'toolbar', 'telemetry', 'recent', 'activity', 'footer']) assert.equal(app.find(`.brain-network-${removed}`), null);
  assert.match(app.find('.brain-network-decoration-note').textContent, /zero AI tokens/);
});

test('region selection reveals real details and routes only on explicit action', (t) => {
  const navigations = [], app = fixture(t, { onNavigate: (panel) => navigations.push(panel) }); app.instance.update(state);
  const planner = app.find('[data-lobe-node="agent:planner"]'); planner.click();
  assert.equal(planner.getAttribute('aria-pressed'), 'true');
  assert.equal(app.find('.brain-network-inspector').hidden, false);
  assert.match(app.find('.brain-network-inspector').textContent, /Decomposes the objective/);
  assert.deepEqual(navigations, []);
  app.find('[data-network-navigate="mission"]').click();
  app.find('[data-lobe-node="module:memory"]').click();
  app.find('[data-network-navigate="knowledge"]').click();
  app.find('[aria-label="Close region details"]').click();
  assert.equal(app.find('.brain-network-inspector').hidden, true);
  assert.equal(app.dom.window.document.activeElement.dataset.lobeNode, 'module:memory');
  assert.deepEqual(navigations, ['mission', 'knowledge']);
});

test('untrusted recorded activity never becomes markup', (t) => {
  const app = fixture(t), hostile = '<img src=x onerror="alert(1)">';
  app.instance.update({ ...state, selectedRun: { ...run, trace: [{ agent: 'researcher', summary: hostile }] } });
  app.find('[data-lobe-node="agent:researcher"]').click();
  assert.equal(app.host.querySelector('img'), null);
  assert.match(app.find('.brain-network-inspector').textContent, /<img/);
});

test('polling preserves keyboard focus and never opens a dismissed detail panel', (t) => {
  const app = fixture(t); app.instance.update(state);
  const node = app.find('[data-lobe-node="agent:researcher"]'); node.focus(); node.click();
  app.instance.update(state);
  assert.equal(app.dom.window.document.activeElement, node);
  app.find('[data-network-navigate="mission"]').focus(); app.instance.update(state);
  assert.equal(app.dom.window.document.activeElement.dataset.networkNavigate, 'mission');
  app.find('.brain-network-shell').dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  app.instance.update(state);
  assert.equal(app.find('.brain-network-inspector').hidden, true);
});

test('zoom changes the projection and reset restores the original within bounds', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install), original = harness.snapshot();
  app.find('[aria-label="Zoom in"]').click(); assert.equal(app.find('.brain-network-zoom').textContent, '110%'); assert.notEqual(harness.snapshot(), original);
  for (let index = 0; index < 40; index++) app.find('[aria-label="Zoom in"]').click();
  assert.equal(app.find('.brain-network-zoom').textContent, '320%'); assert.equal(app.find('[aria-label="Zoom in"]').disabled, true);
  app.find('[aria-label="Reset network view"]').click(); assert.equal(harness.snapshot(), original); assert.equal(app.find('.brain-network-zoom').textContent, '100%');
});

test('neural geometry is deterministic, branched, and spans eight distinct regions', () => {
  const points = buildMatrixBrain();
  assert.equal(points.length, 6400); assert.deepEqual(points, buildMatrixBrain());
  assert.deepEqual(new Set(points.map((point) => point.region)), new Set(BRAIN_REGIONS));
  assert.ok(points.every((point) => [point.x, point.y, point.z].every(Number.isFinite)));
  for (const region of BRAIN_REGIONS) assert.ok(points.filter((point) => point.region === region).length > 150);
  assert.ok(Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)) > 3, 'topology expands into lateral neuron clusters');
  assert.ok(Math.max(...points.map((point) => point.z)) - Math.min(...points.map((point) => point.z)) > 2.5, 'clusters occupy multiple depth planes');
});

test('broker region uses observed connection state and routes to Accounts', (t) => {
  const navigations = [], app = fixture(t, { onNavigate: (panel) => navigations.push(panel) });
  app.find('[data-lobe-node="module:robinhood"]').click();
  assert.match(app.find('.brain-network-inspector').textContent, /check your connection/);
  app.instance.update({ brokerState: { connected: true } });
  assert.match(app.find('.brain-network-inspector').textContent, /connection is saved/);
  app.find('[data-network-navigate="robinhood"]').click();
  assert.deepEqual(navigations, ['robinhood']);
});

test('all eight sections stay in a stable left rail throughout a full orbit', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, (window) => {
    harness.install(window);
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 342, height: 500, left: 0, top: 0 });
  });
  const stage = app.find('.brain-network-stage');
  const ids = [...app.host.querySelectorAll('.brain-network-rail [data-lobe-node]')].map((item) => item.dataset.lobeNode);
  assert.equal(ids.length, 8);
  assert.equal(app.host.querySelectorAll('[aria-label="Agents"] [data-lobe-node]').length, 4);
  assert.equal(app.host.querySelectorAll('[aria-label="Modules"] [data-lobe-node]').length, 4);
  assert.equal(stage.querySelectorAll('[data-lobe-node]').length, 0);
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }));
  for (let index = 0; index <= 32; index++) {
    stage.dispatchEvent(new app.dom.window.MouseEvent('pointermove', { clientX: index * 2 * Math.PI / 32 / .008, clientY: 0, bubbles: true }));
    assert.deepEqual([...app.host.querySelectorAll('.brain-network-rail [data-lobe-node]')].map((item) => item.dataset.lobeNode), ids);
  }
});

test('mobile section navigation excludes hidden controls and restores visible keyboard focus', (t) => {
  const app = fixture(t, {}, (window) => {
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  });
  const rail = app.find('.brain-network-rail'), toggle = app.find('.brain-network-sections-toggle');
  assert.equal(rail.hasAttribute('inert'), true);
  toggle.click(); assert.equal(rail.hasAttribute('inert'), false);
  assert.equal(app.dom.window.document.activeElement, app.find('.brain-network-overview'));
  app.find('[data-lobe-node="module:memory"]').click();
  assert.equal(rail.hasAttribute('inert'), true); assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(app.dom.window.document.activeElement, toggle);
  app.find('[data-network-close]').focus(); app.find('[data-network-close]').click();
  assert.equal(app.dom.window.document.activeElement, toggle);
  toggle.click();
  rail.dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(rail.hasAttribute('inert'), true); assert.equal(app.dom.window.document.activeElement, toggle);
});

test('wheel zoom consumes only canvas scrolling, normalizes deltas and respects both bounds', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install), stage = app.find('.brain-network-stage');
  const scroll = (target, deltaY, deltaMode = 0) => {
    const event = new app.dom.window.WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
    target.dispatchEvent(event); return event.defaultPrevented;
  };
  assert.equal(scroll(stage, -100), true); assert.equal(app.find('.brain-network-zoom').textContent, '116%');
  app.find('[aria-label="Reset network view"]').click();
  scroll(stage, -6.25, 1); assert.equal(app.find('.brain-network-zoom').textContent, '116%');
  assert.equal(scroll(app.find('.brain-network-rail'), 100), false);
  app.find('[data-lobe-node="module:risk"]').click();
  const zoom = app.find('.brain-network-zoom').textContent;
  assert.equal(scroll(app.find('.brain-network-inspector'), 100), false); assert.equal(app.find('.brain-network-zoom').textContent, zoom);
  for (let index = 0; index < 20; index++) scroll(stage, -250);
  assert.equal(app.find('.brain-network-zoom').textContent, '320%');
  for (let index = 0; index < 30; index++) scroll(stage, 250);
  assert.equal(app.find('.brain-network-zoom').textContent, '45%');
});

test('vertical and horizontal drag can pass both poles and return through a full rotation', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install), stage = app.find('.brain-network-stage');
  const send = (type, x, y) => stage.dispatchEvent(new app.dom.window.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }));
  for (const vertical of [true, false]) {
    app.find('[aria-label="Reset network view"]').click();
    const original = harness.lobeAnchors(); send('pointerdown', 0, 0);
    send('pointermove', vertical ? 0 : 200, vertical ? 200 : 0); const beforePole = harness.lobeAnchors();
    send('pointermove', vertical ? 0 : 400, vertical ? 400 : 0); assert.notDeepEqual(harness.lobeAnchors(), beforePole);
    const turn = Math.PI * 2 / .008; send('pointermove', vertical ? 0 : turn, vertical ? turn : 0); send('pointerup', vertical ? 0 : turn, vertical ? turn : 0);
    for (const [index, point] of harness.lobeAnchors().entries()) for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(point[axis] - original[index][axis]) < .000001);
  }
});

test('selection eases a section into the foreground while decorative motion is paused', (t) => {
  const harness = canvasHarness(), app = fixture(t, {}, harness.install);
  app.find('[aria-label="Pause network motion"]').click();
  const original = harness.lobeAnchors(); app.find('[data-lobe-node="module:memory"]').click();
  assert.equal(app.find('.brain-network-shell').dataset.camera, 'focusing');
  assert.deepEqual(harness.lobeAnchors(), original, 'selection must not teleport the camera');
  harness.step(0); harness.step(100); harness.step(200);
  assert.notDeepEqual(harness.lobeAnchors(), original);
  for (let time = 300; time <= 900; time += 100) harness.step(time);
  assert.equal(harness.frames.size, 0); assert.equal(app.find('.brain-network-shell').dataset.camera, 'focused');
  assert.equal(app.find('.brain-network-zoom').textContent, '150%');
  const point = harness.lobeAnchors()[BRAIN_REGIONS.indexOf('cerebellum')];
  assert.ok(Math.abs(point[0] + 1.5 - 356) < .000001);
  assert.ok(Math.abs(point[1] + 1.5 - 308) < .000001);
});

test('new selections retarget from the current view and manual input cancels focus animation', (t) => {
  const harness = canvasHarness(), app = fixture(t, {}, harness.install), stage = app.find('.brain-network-stage');
  app.find('[aria-label="Pause network motion"]').click(); app.find('[data-lobe-node="agent:planner"]').click();
  harness.step(0); harness.step(100); const current = harness.lobeAnchors();
  app.find('[data-lobe-node="module:risk"]').click(); assert.deepEqual(harness.lobeAnchors(), current);
  harness.step(200);
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 50, clientY: 50, bubbles: true }));
  const interrupted = harness.lobeAnchors(); assert.equal(harness.frames.size, 0);
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointermove', { clientX: 80, clientY: 90, bubbles: true }));
  assert.notDeepEqual(harness.lobeAnchors(), interrupted);
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointerup', { clientX: 80, clientY: 90, bubbles: true }));
  const held = harness.lobeAnchors(); app.instance.refresh(); assert.deepEqual(harness.lobeAnchors(), held);
  assert.equal(app.find('.brain-network-shell').dataset.camera, 'manual');
});

test('reduced motion selects immediately and a preference change finishes pending focus', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install);
  app.find('[data-lobe-node="agent:critic"]').click();
  assert.equal(harness.frames.size, 0); assert.equal(app.find('.brain-network-shell').dataset.camera, 'focused');
  harness.setReducedMotion(false); app.find('[data-lobe-node="agent:researcher"]').click();
  assert.equal(app.find('.brain-network-shell').dataset.camera, 'focusing');
  harness.setReducedMotion(true);
  assert.equal(harness.frames.size, 0); assert.equal(app.find('.brain-network-shell').dataset.camera, 'focused');
});

test('reduced motion and disposal suspend rendering and remove handlers', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install);
  assert.ok(app.find('[aria-label="Resume network motion"]')); assert.equal(harness.frames.size, 0);
  harness.setReducedMotion(false); assert.equal(harness.frames.size, 1);
  harness.setReducedMotion(true); assert.equal(harness.frames.size, 0);
  app.instance.dispose(); assert.deepEqual(harness.disconnected, ['resize', 'intersection']);
  const before = app.host.innerHTML; app.instance.update(state); app.instance.refresh(); app.find('[aria-label="Zoom in"]').click();
  assert.equal(app.host.innerHTML, before);
});

test('theme changes repaint paused canvas with the current palette', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install);
  app.dom.window.document.documentElement.dataset.theme = 'daylight';
  app.host.style.setProperty('--red', '#cf0f22'); app.host.style.setProperty('--red-glow', '#e0303f');
  app.dom.window.document.dispatchEvent(new app.dom.window.Event('synergy-module:themechange'));
  assert.match(harness.snapshot(), /#cf0f22/); assert.doesNotMatch(harness.snapshot(), /"lighter"/); assert.equal(harness.frames.size, 0);
  const paints = harness.paints; app.instance.dispose();
  app.dom.window.document.dispatchEvent(new app.dom.window.Event('synergy-module:themechange')); assert.equal(harness.paints, paints);
});

test('idle binary activity changes at bounded paint rate without moving the network; pause preserves its exact phase', (t) => {
  const harness = canvasHarness(), app = fixture(t, {}, harness.install);
  assert.equal(app.find('.brain-network-shell').dataset.motion, 'running');
  harness.step(0); const first = harness.snapshot(), paints = harness.paints, anchors = harness.lobeAnchors(), firstGlyphs = harness.glyphs();
  assert.equal(anchors.length, BRAIN_REGIONS.length);
  harness.step(10); harness.step(20); assert.equal(harness.paints, paints);
  harness.step(34); assert.equal(harness.paints, paints + 1); assert.notEqual(harness.snapshot(), first);
  for (let time = 74; time <= 1074; time += 40) { harness.step(time); assert.deepEqual(harness.lobeAnchors(), anchors); }
  assert.notDeepEqual(harness.glyphs(), firstGlyphs);
  const positions = (glyphs) => glyphs.map(([, , x, y]) => [x, y]).sort(([ax, ay], [bx, by]) => ax - bx || ay - by);
  assert.notDeepEqual(positions(harness.glyphs()), positions(firstGlyphs), 'binary glyphs move locally');
  const moving = harness.snapshot(); app.find('[aria-label="Pause network motion"]').click();
  assert.equal(harness.frames.size, 0); assert.equal(harness.snapshot(), moving);
  app.instance.refresh(); assert.equal(harness.snapshot(), moving);
  app.find('[aria-label="Resume network motion"]').click(); harness.step(90000); assert.equal(harness.snapshot(), moving);
  harness.step(90040); assert.notEqual(harness.snapshot(), moving);
});

test('rotation and movement hold after input stops; route remount retains view and a fresh document resets it', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install), stage = app.find('.brain-network-stage');
  const original = harness.lobeAnchors();
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointermove', { clientX: 180, clientY: 120, bubbles: true }));
  stage.dispatchEvent(new app.dom.window.MouseEvent('pointerup', { clientX: 180, clientY: 120, bubbles: true }));
  const rotated = harness.lobeAnchors(); assert.notDeepEqual(rotated, original);
  app.find('[aria-label="Move network"]').click();
  stage.dispatchEvent(new app.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const moved = harness.lobeAnchors(); assert.notDeepEqual(moved, rotated); app.instance.refresh(); assert.deepEqual(harness.lobeAnchors(), moved);
  app.instance.dispose(); const next = createBrainNetwork(app.host); t.after(() => next.dispose()); assert.deepEqual(harness.lobeAnchors(), moved);
  const freshHarness = canvasHarness({ reducedMotion: true }); fixture(t, {}, freshHarness.install); assert.deepEqual(freshHarness.lobeAnchors(), original);
  app.find('[aria-label="Reset network view"]').click(); assert.deepEqual(harness.lobeAnchors(), original);
});

test('touch drag cancellation, lost capture and blur release the gesture for the next interaction', (t) => {
  const harness = canvasHarness({ reducedMotion: true }), app = fixture(t, {}, harness.install), stage = app.find('.brain-network-stage');
  const pointer = (type, x, y) => { const event = new app.dom.window.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true }); Object.defineProperties(event, { pointerId: { value: 7 }, pointerType: { value: 'touch' } }); stage.dispatchEvent(event); };
  for (const interruption of ['pointercancel', 'lostpointercapture', 'blur']) {
    pointer('pointerdown', 10, 10); pointer('pointermove', 90, 40); const afterDrag = harness.lobeAnchors();
    (interruption === 'blur' ? app.dom.window : stage).dispatchEvent(new app.dom.window.Event(interruption));
    assert.equal(stage.classList.contains('brain-network-dragging'), false);
    pointer('pointermove', 180, 80); assert.deepEqual(harness.lobeAnchors(), afterDrag);
    pointer('pointerdown', 0, 0); pointer('pointermove', 30, 20); assert.notDeepEqual(harness.lobeAnchors(), afterDrag); pointer('pointerup', 30, 20);
  }
});

test('background tabs and hidden panels suspend rendering without losing phase', (t) => {
  const harness = canvasHarness(), app = fixture(t, {}, harness.install);
  harness.step(0); harness.step(50); const current = harness.snapshot();
  harness.setHidden(app.dom.window, true); assert.equal(harness.frames.size, 0);
  harness.setHidden(app.dom.window, false); harness.step(100000); assert.equal(harness.snapshot(), current);
  app.host.hidden = true; harness.step(100040); assert.equal(harness.frames.size, 0);
  app.host.hidden = false; app.instance.refresh(); harness.step(200000); assert.equal(harness.snapshot(), current);
  harness.setIntersection(false); assert.equal(harness.frames.size, 0);
  harness.setIntersection(true); harness.step(300000); assert.equal(harness.snapshot(), current);
});
