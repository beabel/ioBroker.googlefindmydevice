'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Diagnostics, categorizeSkip } = require('../lib/diagnostics');

test('skipped reports are sorted into short categories', () => {
  assert.equal(categorizeSkip('Unsupported key part length 33 (only 20 and 32 bytes are supported)'), 'unsupported-key-part-33');
  assert.equal(categorizeSkip('MAC check failed (no P-256 reading matched)'), 'authentication-failed');
  assert.equal(categorizeSkip('Unsupported state or unable to authenticate data'), 'authentication-failed');
  assert.equal(categorizeSkip("The provided key part isn't a valid P-256 public key."), 'invalid-key-part');
  assert.equal(categorizeSkip('missing or implausible time of the report'), 'bad-time');
  assert.equal(categorizeSkip('Decrypted coordinates are out of range'), 'bad-coordinates');
  assert.equal(categorizeSkip('something else'), 'other');
});

test('the report holds model data and counts and nothing that identifies a tracker or a position', () => {
  const diagnostics = new Diagnostics();
  diagnostics.setDevice('real-google-id-1', {
    manufacturer: 'Maker',
    model: 'Tag 2',
    deviceType: 'DEVICE_TYPE_BIKE',
    fastPairModelId: '003200',
    identifierKind: 'tracker',
    capabilities: [30, 31, 32],
  });
  diagnostics.recordAnswer('real-google-id-1', {
    timestamp: 1000,
    status: 1,
    isOwnReport: false,
    keyPartLength: 32,
    reading: 'p256/be_mod_n/nonce8',
    lat: 50.1234,
    lon: 12.5678,
  }, 1060);
  diagnostics.recordAnswer('real-google-id-1', { timestamp: 2000, status: 0, semantic: 'Home' }, 2005);
  diagnostics.recordAnswer('real-google-id-1', null);
  diagnostics.recordSkip('real-google-id-1', { reason: 'Unsupported key part length 33', keyPartLength: 33 });
  diagnostics.recordLocate('real-google-id-1', 'retried');
  diagnostics.recordLocate('real-google-id-1', 'ok');
  diagnostics.recordSound('real-google-id-1', 'start');
  diagnostics.recordSound('real-google-id-1', 'rejected');

  const report = diagnostics.report('0.1.9');
  const text = diagnostics.reportJson('0.1.9');
  assert.equal(report.adapter, '0.1.9');
  assert.equal(report.trackers.length, 1);
  const [tracker] = report.trackers;
  assert.equal(tracker.tracker, 1);
  assert.equal(tracker.manufacturer, 'Maker');
  assert.deepEqual(tracker.capabilities, [30, 31, 32]);
  assert.equal(tracker.answers, 3);
  assert.equal(tracker.withoutReport, 1);
  assert.deepEqual(tracker.reportTypes, { LAST_KNOWN: 1, SEMANTIC: 1 });
  assert.deepEqual(tracker.origin, { ownDevice: 0, relayed: 1 });
  assert.deepEqual(tracker.keyPartLengths, { 32: 1 });
  assert.deepEqual(tracker.readings, { 'p256/be_mod_n/nonce8': 1 });
  assert.deepEqual(tracker.skipped, { 'unsupported-key-part-33': 1 });
  assert.deepEqual(tracker.newestReportAgeSeconds, { last: 5, max: 60 });
  assert.equal(tracker.locateRequests.retried, 1);
  assert.equal(tracker.locateRequests.ok, 1);
  assert.equal(tracker.soundRequests.start, 1);
  assert.equal(tracker.soundRequests.rejected, 1);

  for (const secret of ['real-google-id-1', '50.1234', '12.5678', 'Home']) {
    assert.ok(!text.includes(secret), `the report must not contain ${secret}`);
  }
});

test('trackers are numbered in the order they were first seen', () => {
  const diagnostics = new Diagnostics();
  diagnostics.setDevice('b', { model: 'B' });
  diagnostics.setDevice('a', { model: 'A' });
  assert.deepEqual(diagnostics.report('x').trackers.map(t => [t.tracker, t.model]), [
    [1, 'B'],
    [2, 'A'],
  ]);
});
