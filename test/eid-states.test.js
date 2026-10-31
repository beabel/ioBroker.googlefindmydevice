'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeEidWindows, msUntilNextWindow } = require('../lib/eid-states');
const fmdn = require('../lib/fmdn-crypto');

const idKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
// 8704000 s is a multiple of 1024 s; its EID is the known vector from fmdn-crypto.test.js
const WINDOW_START = 8704000;

test('computeEidWindows: current window matches the known EID vector', () => {
  const result = computeEidWindows(idKey, (WINDOW_START + 300) * 1000);
  assert.equal(result.current, '9d8188455646a1b02ef769bf9845f095c1e79499');
  assert.equal(result.windowStart, WINDOW_START * 1000);
  assert.equal(result.windowSeconds, 1024);
});

test('computeEidWindows: previous and next are the adjacent windows, all 40 hex characters', () => {
  const result = computeEidWindows(idKey, (WINDOW_START + 1000) * 1000);
  assert.equal(result.previous, fmdn.generateEid(idKey, WINDOW_START - 1024).toString('hex'));
  assert.equal(result.next, fmdn.generateEid(idKey, WINDOW_START + 1024).toString('hex'));
  for (const eid of [result.previous, result.current, result.next]) {
    assert.match(eid, /^[0-9a-f]{40}$/);
  }
  assert.equal(new Set([result.previous, result.current, result.next]).size, 3);
});

test('computeEidWindows: stays the same within a window and changes at the boundary', () => {
  const first = computeEidWindows(idKey, WINDOW_START * 1000);
  const last = computeEidWindows(idKey, (WINDOW_START + 1023) * 1000 + 999);
  const after = computeEidWindows(idKey, (WINDOW_START + 1024) * 1000);
  assert.equal(first.current, last.current);
  assert.equal(after.current, first.next);
  assert.equal(after.previous, first.current);
});

test('computeEidWindows: no usable key yields null instead of throwing', () => {
  assert.equal(computeEidWindows(null, Date.now()), null);
  assert.equal(computeEidWindows(undefined, Date.now()), null);
  assert.equal(computeEidWindows(Buffer.alloc(5), Date.now()), null);
  assert.equal(computeEidWindows('not a buffer', Date.now()), null);
});

test('msUntilNextWindow: counts down to the next boundary and is never 0', () => {
  assert.equal(msUntilNextWindow(WINDOW_START * 1000), 1024000);
  assert.equal(msUntilNextWindow((WINDOW_START + 1023) * 1000), 1000);
  assert.equal(msUntilNextWindow((WINDOW_START + 1024) * 1000 - 1), 1);
});
