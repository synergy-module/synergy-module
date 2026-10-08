const SPHERE_RAMP = [".", "·", ":", "+", "*", "#", "@"];

export function buildSphereFrame(cols, rows, angle) {
  const buffer = [], zBuffer = [];
  for (let row = 0; row < rows; row += 1) { buffer.push(new Array(cols).fill(" ")); zBuffer.push(new Array(cols).fill(0)); }
  const centerX = cols / 2, centerY = rows / 2;
  const cameraDistance = 3.2;
  const radius = Math.min(cols, rows * 2) * 0.46 * cameraDistance;
  const cosAngle = Math.cos(angle), sinAngle = Math.sin(angle);

  function projected(theta, phi) {
    const x0 = Math.cos(phi) * Math.cos(theta), y0 = Math.sin(phi), z0 = Math.cos(phi) * Math.sin(theta);
    const x1 = x0 * cosAngle + z0 * sinAngle, z1 = -x0 * sinAngle + z0 * cosAngle;
    const inverseDepth = 1 / (cameraDistance + z1);
    return { x: Math.round(centerX + x1 * radius * inverseDepth), y: Math.round(centerY - y0 * radius * 0.5 * inverseDepth), inverseDepth, z: z1 };
  }

  function plotBody(theta, phi) {
    const point = projected(theta, phi);
    if (point.x < 0 || point.x >= cols || point.y < 0 || point.y >= rows || point.inverseDepth <= zBuffer[point.y][point.x]) return;
    zBuffer[point.y][point.x] = point.inverseDepth;
    const brightness = Math.max(0, Math.min(1, (point.z + 1) / 2));
    buffer[point.y][point.x] = SPHERE_RAMP[Math.floor(brightness * (SPHERE_RAMP.length - 1))];
  }

  for (let meridian = 0; meridian < 16; meridian += 1) {
    const theta = (meridian / 16) * Math.PI * 2;
    for (let point = 0; point <= 64; point += 1) plotBody(theta, -Math.PI / 2 + (point / 64) * Math.PI);
  }
  for (let parallel = 1; parallel < 8; parallel += 1) {
    const phi = -Math.PI / 2 + (parallel / 8) * Math.PI;
    for (let point = 0; point <= 110; point += 1) plotBody((point / 110) * Math.PI * 2, phi);
  }

  const word = "SYNERGY MODULE";
  const textRow = Math.round(centerY);
  const beltHalfRows = Math.max(1, Math.round(rows * 0.1));
  for (let row = textRow - beltHalfRows; row <= textRow + beltHalfRows; row += 1) {
    if (row >= 0 && row < rows) buffer[row].fill(" ");
  }
  const textDepth = new Array(rows).fill(0).map(() => new Array(cols).fill(-Infinity));
  for (let index = 0; index < word.length; index += 1) {
    const point = projected((index / (word.length - 1) - 0.5) * 1.5, 0);
    if (point.z >= -0.05 || point.x < 0 || point.x >= cols || point.y < 0 || point.y >= rows) continue;
    if (point.inverseDepth > textDepth[textRow][point.x]) { textDepth[textRow][point.x] = point.inverseDepth; buffer[textRow][point.x] = word[index]; }
  }
  return buffer.map((row) => row.join("")).join("\n");
}

export function startSphereRenderer({ documentRef, windowRef, reducedMotion = false }) {
  if (!documentRef.querySelector("[data-sphere]")) return () => {};
  let angle = 0;
  const render = () => {
    angle += 0.09;
    documentRef.querySelectorAll("[data-sphere]").forEach((sphere) => {
      sphere.textContent = buildSphereFrame(Number(sphere.dataset.cols), Number(sphere.dataset.rows), angle);
    });
  };
  render();
  if (reducedMotion) return () => {};
  const interval = windowRef.setInterval(render, 60);
  return () => windowRef.clearInterval(interval);
}
