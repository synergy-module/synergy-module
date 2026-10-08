import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBrainView, rotateView, rotatePoint, focusBrainView, interpolateBrainView } from '../../public/js/brain/brain-camera.js';
import { BRAIN_REGION_CENTERS } from '../../public/js/brain/brain-network-renderer.js';

test('mixed free rotations remain normalized and preserve the geometry', () => {
  let orientation = defaultBrainView().orientation;
  for (let i = 0; i < 2000; i++) orientation = rotateView(orientation, Math.sin(i) * .2, Math.cos(i) * .3);
  assert.ok(Math.abs(Math.hypot(...orientation) - 1) < 1e-12);
  for (const point of Object.values(BRAIN_REGION_CENTERS)) assert.ok(Math.abs(Math.hypot(...rotatePoint(orientation, point)) - Math.hypot(...point)) < 1e-12);
});

test('every focus target faces the camera from arbitrary orientations, including the opposite pole', () => {
  for (const orientation of [[0, 0, 0, 1], rotateView(defaultBrainView().orientation, 2.3, -4.7)]) {
    for (const center of [...Object.values(BRAIN_REGION_CENTERS), [0, 0, -1]]) {
      const view = focusBrainView({ ...defaultBrainView(), orientation }, center, 1000);
      const point = rotatePoint(view.orientation, center);
      assert.ok(Math.abs(point[0]) < .000001); assert.ok(Math.abs(point[1]) < .000001); assert.ok(point[2] > 0);
    }
  }
});

test('focus interpolation takes a stable shortest path for equivalent quaternion signs', () => {
  const from = defaultBrainView(), to = { ...from, orientation: from.orientation.map((value) => -value), zoom: 2 };
  const halfway = interpolateBrainView(from, to, .5);
  assert.deepEqual(rotatePoint(halfway.orientation, [1, 0, 0]), rotatePoint(from.orientation, [1, 0, 0]));
  assert.equal(halfway.zoom, 1.5);
});
