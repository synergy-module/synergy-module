// Screen-space quaternion rotation has no poles, pitch limits, or fixed up axis.
const normalize = (q) => { const length = Math.hypot(...q) || 1; return q.map((value) => value / length); };
export function multiplyRotation(a, b) {
  const [x, y, z, w] = a, [u, v, t, s] = b;
  return normalize([w * u + x * s + y * t - z * v, w * v - x * t + y * s + z * u,
    w * t + x * v - y * u + z * s, w * s - x * u - y * v - z * t]);
}
export function rotatePoint([qx, qy, qz, qw], [x, y, z]) {
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}
export function rotateView(orientation, horizontal, vertical) {
  const angle = Math.hypot(horizontal, vertical);
  if (!angle) return [...orientation];
  const scale = Math.sin(angle / 2) / angle;
  return multiplyRotation([vertical * scale, horizontal * scale, 0, Math.cos(angle / 2)], orientation);
}
export function defaultBrainView() {
  return { zoom: 1, orientation: multiplyRotation([Math.sin(.14 / 2), 0, 0, Math.cos(.14 / 2)], [0, Math.sin(-.28 / 2), 0, Math.cos(-.28 / 2)]), panX: 0, panY: 0 };
}
export const copyBrainView = (view) => ({ ...view, orientation: [...view.orientation] });
export const MIN_BRAIN_ZOOM = .45;
export const MAX_BRAIN_ZOOM = 3.2;
export const clampBrainZoom = (zoom) => Math.min(MAX_BRAIN_ZOOM, Math.max(MIN_BRAIN_ZOOM, zoom));

export function focusBrainView(view, center, width) {
  const direction = rotatePoint(view.orientation, center), length = Math.hypot(...direction);
  const [x, y, z] = direction.map((value) => value / length);
  // Shortest rotation from the selected hub to the front, including the opposite pole.
  const turn = z < -.999999 ? [1, 0, 0, 0] : normalize([y, -x, 0, 1 + z]);
  return { orientation: multiplyRotation(turn, view.orientation), zoom: 1.5,
    panX: width >= 760 ? -144 / width : 0, panY: width >= 760 ? -.02 : -.16 };
}

export function interpolateBrainView(from, to, progress) {
  const t = Math.min(1, Math.max(0, progress));
  const eased = t * t * t * (t * (t * 6 - 15) + 10);
  let target = to.orientation, dot = from.orientation.reduce((sum, value, index) => sum + value * target[index], 0);
  if (dot < 0) { target = target.map((value) => -value); dot = -dot; }
  const angle = Math.acos(Math.min(1, dot)), sine = Math.sin(angle);
  const a = sine > .0001 ? Math.sin((1 - eased) * angle) / sine : 1 - eased;
  const b = sine > .0001 ? Math.sin(eased * angle) / sine : eased;
  return { orientation: normalize(from.orientation.map((value, index) => a * value + b * target[index])),
    zoom: from.zoom + (to.zoom - from.zoom) * eased,
    panX: from.panX + (to.panX - from.panX) * eased,
    panY: from.panY + (to.panY - from.panY) * eased };
}
