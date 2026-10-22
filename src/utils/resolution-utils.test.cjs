const test = require('node:test');
const assert = require('node:assert/strict');

let normalizeOutputResolution;
let calculateOutputDimensions;

test.before(async () => {
  ({ normalizeOutputResolution, calculateOutputDimensions } = await import('./resolution-utils.mjs'));
});

test('output resolution parsing falls back to original for unknown values', () => {
  assert.equal(normalizeOutputResolution('720'), '720');
  assert.equal(normalizeOutputResolution('720p'), 'source');
});

test('dimension calculation preserves aspect ratio without upscaling', () => {
  const result = calculateOutputDimensions({ width: 1920, height: 1080 }, { maxHeight: '720' });
  assert.deepEqual(result, { width: 1280, height: 720 });
});

test('portrait source is constrained by output height and GIF width', () => {
  const result = calculateOutputDimensions({ width: 600, height: 1200 }, {
    maxHeight: '1080',
    maxWidth: 480
  });
  assert.deepEqual(result, { width: 480, height: 960 });
});

test('small source remains at native dimensions when the selected limit is larger', () => {
  const result = calculateOutputDimensions({ width: 640, height: 360 }, { maxHeight: '1080' });
  assert.deepEqual(result, { width: 640, height: 360 });
});
