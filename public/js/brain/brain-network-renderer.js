// Volumetric neural topology in the Redline binary palette.
const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const BRAIN_REGIONS = ['frontal-l', 'frontal-r', 'parietal', 'temporal-l', 'temporal-r', 'occipital', 'cerebellum', 'stem'];
const CENTERS = [[-1.12, .67, .6], [.94, .73, -.74], [.02, 1.23, .04], [-.81, -.72, .82], [1.02, -.68, -.5], [1.4, .06, .55], [-1.38, -.13, -.56], [.02, -1.24, -.24]];
function random(seed) { let value = seed >>> 0; return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; }; }
const depthLayer = (depth) => Math.max(0, Math.min(5, Math.floor((depth + 1.8) / .6)));

function buildTopology(seed = 42) {
  const r = random(seed), nodes = [], edges = [], hubs = [];
  const connect = (from, point, weight = 0) => {
    const to = nodes.push(point) - 1;
    edges.push([from, to, weight]);
    return to;
  };
  for (const [regionIndex, center] of CENTERS.entries()) {
    const region = BRAIN_REGIONS[regionIndex], hub = nodes.length;
    hubs.push(hub); nodes.push({ x: center[0], y: center[1], z: center[2], region, hub: true });
    // Spherical dendrites, rather than a radial XY fan: every cluster has volume.
    for (let branch = 0; branch < 24; branch++) {
      const elevation = 1 - 2 * (branch + .5) / 24, radial = Math.sqrt(1 - elevation * elevation);
      const angle = branch * GOLDEN_ANGLE + regionIndex * .8;
      const direction = [Math.cos(angle) * radial, Math.sin(angle) * radial, elevation * 1.12];
      const length = .43 + r() * .19, bend = (r() - .5) * .24;
      let parent = hub;
      for (let segment = 1; segment <= 5; segment++) {
        const t = segment / 5, sway = Math.sin(t * Math.PI) * bend;
        const node = { x: center[0] + direction[0] * length * t + sway, y: center[1] + direction[1] * length * t - sway * .6, z: center[2] + direction[2] * length * t + sway, region };
        const index = connect(parent, node, segment <= 2 ? 1 : 0);
        if (segment === 3 || segment === 5) {
          const forkAngle = angle + (segment === 3 ? .9 : -.8), forkLength = .08 + r() * .075;
          const fork = connect(index, { x: node.x + Math.cos(forkAngle) * forkLength, y: node.y + Math.sin(forkAngle) * forkLength, z: node.z + (r() - .5) * .22, region });
          connect(fork, { x: nodes[fork].x + direction[0] * .06, y: nodes[fork].y + direction[1] * .06, z: nodes[fork].z + direction[2] * .08, region });
        }
        parent = index;
      }
    }
  }
  // Parallel, bowed axons create thick cables with air between filaments.
  const bundle = (from, to, filaments = 4) => {
    const a = nodes[from], b = nodes[to], dx = b.x - a.x, dy = b.y - a.y;
    const planarLength = Math.hypot(dx, dy) || 1, bend = (r() < .5 ? -1 : 1) * (.12 + r() * .2);
    for (let strand = 0; strand < filaments; strand++) {
      let parent = from;
      const spread = (strand - (filaments - 1) / 2) * .034;
      for (let step = 1; step < 12; step++) {
        const t = step / 12, arc = Math.sin(t * Math.PI);
        parent = connect(parent, {
          x: a.x + dx * t - dy / planarLength * (bend + spread) * arc,
          y: a.y + dy * t + dx / planarLength * (bend + spread) * arc,
          z: a.z + (b.z - a.z) * t + (bend + spread * 2) * arc,
          region: t < .5 ? a.region : b.region,
        }, strand === 1 ? 2 : 1);
      }
      edges.push([parent, to, strand === 1 ? 2 : 1]);
    }
  };
  for (let index = 0; index < hubs.length; index++) {
    for (let other = index + 1; other < hubs.length; other++) {
      const a = nodes[hubs[index]], b = nodes[hubs[other]];
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 2.25) bundle(hubs[index], hubs[other]);
    }
  }
  // A layered inner mesh ties the outer clusters together without a solid shell.
  const core = nodes.length;
  for (let index = 0; index < 18; index++) {
    const elevation = 1 - 2 * (index + .5) / 18, radius = Math.sqrt(1 - elevation * elevation) * .4;
    nodes.push({ x: Math.cos(index * GOLDEN_ANGLE) * radius, y: Math.sin(index * GOLDEN_ANGLE) * radius, z: elevation * .58, region: BRAIN_REGIONS[index % BRAIN_REGIONS.length] });
    if (index) edges.push([core + index - 1, core + index, 1]);
    if (index > 4) edges.push([core + index - 5, core + index, 0]);
  }
  for (let index = 0; index < hubs.length; index++) bundle(hubs[index], core + index * 2, 3);
  return { nodes, edges, hubs };
}

function binaryFilaments(graph, count, seed) {
  const r = random(seed + 13), points = [];
  for (let index = 0; index < count; index++) {
    const [from, to, weight] = graph.edges[index % graph.edges.length], a = graph.nodes[from], b = graph.nodes[to], t = r();
    const jitter = index % 5 === 0 ? .11 : weight === 2 ? .026 : .016;
    points.push({ x: a.x + (b.x - a.x) * t + (r() - .5) * jitter, y: a.y + (b.y - a.y) * t + (r() - .5) * jitter, z: a.z + (b.z - a.z) * t + (r() - .5) * jitter, region: t < .5 ? a.region : b.region });
  }
  return points;
}

/** Binary filaments follow connected dendrites rather than an anatomical shell. */
export function buildMatrixBrain(count = 6400, seed = 42) {
  return binaryFilaments(buildTopology(seed), count, seed);
}

/** The clock changes binary activity only. Camera transforms always belong to the user. */
export function createBrainNetworkRenderer(context, colors = {}) {
  let red = colors.red || '#ff2e43', glow = colors.glow || '#ff6675', line = colors.line || '#493039', mono = colors.mono || '"JetBrains Mono", monospace', dark = colors.dark !== false;
  const topology = buildTopology(), r = random(9);
  const decorated = binaryFilaments(topology, 6400, 42).map((point) => ({ ...point, glyph: r() < .5 ? 0 : 1, delay: r() * 6 }));
  const projected = decorated.map((point) => ({ x: 0, y: 0, glyph: point.glyph, region: point.region }));
  let anchors = new Map(), projectionKey, neuronPoints, binaryPoints, edgeBuckets;
  const render = ({ width, height, zoom = 1, time = 0, yaw = -.28, pitch = .14, panX = 0, panY = 0, selectedRegion }) => {
    context.clearRect(0, 0, width, height);
    const seconds = time / 1000;
    // Reproject only on user interaction or resize; idle activity reuses fixed geometry.
    const key = [width, height, zoom, yaw, pitch, panX, panY, selectedRegion].join(':');
    if (key !== projectionKey) {
      projectionKey = key;
      const cx = width * (.5 + panX), cy = height * (.46 + panY);
      const scale = Math.min(width * (width < 600 ? .17 : .205), height * .205) * zoom;
      const cosine = Math.cos(yaw), sine = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const project = (point) => {
        const xx = point.x * cosine + point.z * sine, zz = -point.x * sine + point.z * cosine;
        const yy = point.y * cp - zz * sp, depth = point.y * sp + zz * cp, perspective = 4.6 / (4.6 - depth);
        return { x: cx + xx * scale * perspective, y: cy - yy * scale * perspective, depth, perspective };
      };
      neuronPoints = topology.nodes.map(project);
      binaryPoints = decorated.map(project);
      edgeBuckets = Array.from({ length: 36 }, () => []);
      for (const edge of topology.edges) {
        const [from, to, weight] = edge, layer = depthLayer((neuronPoints[from].depth + neuronPoints[to].depth) / 2);
        const selected = topology.nodes[from].region === selectedRegion ? 1 : 0;
        edgeBuckets[layer * 6 + weight * 2 + selected].push(edge);
      }
      anchors = new Map(topology.hubs.map((index) => [topology.nodes[index].region, neuronPoints[index]]));
    }
    context.lineCap = 'round';
    for (const [bucket, items] of edgeBuckets.entries()) {
      const layer = Math.floor(bucket / 6), weight = Math.floor(bucket % 6 / 2), selected = bucket % 2;
      context.strokeStyle = selected ? glow : weight ? red : line;
      context.lineWidth = (.35 + weight * .45 + layer * .08) * Math.max(.8, zoom);
      context.globalAlpha = selected ? .55 + layer * .05 : (weight ? .12 : .2) + layer * .06;
      context.beginPath();
      for (const [from, to] of items) { const a = neuronPoints[from], b = neuronPoints[to]; context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); }
      context.stroke();
    }
    context.fillStyle = red;
    for (const [index, point] of neuronPoints.entries()) {
      const hub = topology.nodes[index].hub, layer = depthLayer(point.depth);
      context.globalAlpha = hub ? .9 : .14 + layer * .05;
      if (hub) {
        const radius = 7 * zoom * point.perspective;
        context.strokeStyle = topology.nodes[index].region === selectedRegion ? glow : red;
        context.lineWidth = 1.2 * point.perspective;
        context.beginPath(); context.arc(point.x, point.y, radius, 0, TAU); context.stroke();
        context.globalAlpha = .4;
        context.beginPath(); context.ellipse(point.x, point.y, radius * 1.6, radius * .5, -.5, 0, TAU); context.stroke();
        context.fillRect(point.x - 1.2, point.y - 1.2, 2.4, 2.4);
      } else {
        const size = .6 + layer * .2;
        context.fillRect(point.x - size / 2, point.y - size / 2, size, size);
      }
    }
    const buckets = Array.from({ length: 18 }, () => []);
    for (let index = 0; index < decorated.length; index++) {
      const point = decorated[index], base = binaryPoints[index], p = projected[index], layer = depthLayer(base.depth);
      const beat = seconds * (1.8 + (index % 11) * .17) + point.delay;
      let signal = Math.imul(index + 1, 374761393) ^ Math.imul(Math.floor(beat) + 1, 668265263);
      signal = Math.imul(signal ^ (signal >>> 13), 1274126177) >>> 0;
      const burst = signal % 100 < 15, pulse = burst ? Math.sin((beat % 1) * Math.PI) * zoom : 0;
      p.x = base.x + pulse * ((signal >>> 8 & 1) ? 2.4 : -2.4);
      p.y = base.y + pulse * ((signal >>> 9 & 1) ? 4.5 : -4.5);
      p.glyph = point.glyph ^ (signal & 1);
      buckets[layer * 3 + (point.region === selectedRegion ? 2 : burst ? 1 : 0)].push(p);
    }
    context.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (const [bucket, items] of buckets.entries()) {
      const layer = Math.floor(bucket / 3), kind = bucket % 3;
      context.font = `${kind === 2 ? '600 ' : ''}${((4.2 + layer * .64) * Math.max(.8, zoom)).toFixed(1)}px ${mono}`;
      context.fillStyle = kind ? glow : red;
      context.globalAlpha = Math.min(.9, .1 + layer * .09 + (kind ? .24 : 0));
      for (const p of items) context.fillText(String(p.glyph), p.x, p.y);
    }
    context.globalCompositeOperation = 'source-over'; context.globalAlpha = 1;
    return anchors;
  };
  render.hitTest = (x, y) => {
    let distance = 225, region = null;
    for (const [name, point] of anchors) {
      const delta = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (delta < distance) { distance = delta; region = name; }
    }
    for (let index = 0; index < projected.length; index += 2) {
      const point = projected[index], delta = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (delta < distance) { distance = delta; region = point.region; }
    }
    return region;
  };
  render.setColors = (next = {}) => { red = next.red || red; glow = next.glow || glow; line = next.line || line; mono = next.mono || mono; dark = next.dark !== false; };
  return render;
}
