'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  looksCorrupted,
  clampMinutes,
  canonicIdToStateId,
  describeDevice,
  ENCRYPTED_NATIVE_FIELDS,
} = require('../lib/util');

test('looksCorrupted: empty values are never considered corrupted', () => {
  for (const field of ENCRYPTED_NATIVE_FIELDS) {
    assert.equal(looksCorrupted(field, ''), false);
    assert.equal(looksCorrupted(field, undefined), false);
  }
});

test('looksCorrupted: plain printable tokens are fine, binary garbage is not', () => {
  assert.equal(looksCorrupted('aasToken', 'aas_et/AKppINabc-DEF_123=='), false);
  assert.equal(looksCorrupted('oauthToken', 'oauth2_4/0AbCd'), false);
  assert.equal(looksCorrupted('securityToken', '1234567890'), false);
  assert.equal(looksCorrupted('aasToken', 'abc\u0001\u0099def'), true);
  assert.equal(looksCorrupted('securityToken', 'äöü'), true);
});

test('looksCorrupted: ownerKey must be a hex string', () => {
  assert.equal(looksCorrupted('ownerKey', '00ff10AB'), false);
  assert.equal(looksCorrupted('ownerKey', 'not-hex!'), true);
  assert.equal(looksCorrupted('ownerKey', '0a 0b'), true);
});

test('looksCorrupted: sharedKeyJson must be valid JSON', () => {
  assert.equal(looksCorrupted('sharedKeyJson', '{"finder_hw":[]}'), false);
  assert.equal(looksCorrupted('sharedKeyJson', '{"finder_hw":'), true);
  assert.equal(looksCorrupted('sharedKeyJson', '\u0001\u0002'), true);
});

test('clampMinutes: keeps values inside the range', () => {
  assert.equal(clampMinutes(15, 1, 1440, 15), 15);
  assert.equal(clampMinutes('30', 1, 1440, 15), 30);
  assert.equal(clampMinutes(1, 1, 1440, 15), 1);
  assert.equal(clampMinutes(1440, 1, 1440, 15), 1440);
});

test('clampMinutes: caps huge values so setTimeout can never overflow', () => {
  const capped = clampMinutes(1e12, 1, 1440, 15);
  assert.equal(capped, 1440);
  assert.ok(capped * 60 * 1000 < 2 ** 31, 'must fit into setTimeout\'s 32-bit millisecond limit');
});

test('clampMinutes: raises too-small values to the minimum', () => {
  assert.equal(clampMinutes(-5, 5, 1440, 60), 5);
  assert.equal(clampMinutes(1, 5, 1440, 60), 5);
});

test('clampMinutes: unusable values fall back to the default', () => {
  assert.equal(clampMinutes(undefined, 1, 1440, 15), 15);
  assert.equal(clampMinutes(null, 1, 1440, 15), 15);
  assert.equal(clampMinutes('abc', 1, 1440, 15), 15);
  assert.equal(clampMinutes(NaN, 1, 1440, 15), 15);
  assert.equal(clampMinutes(0, 1, 1440, 15), 15);
});

test('canonicIdToStateId: keeps valid ids and replaces everything else', () => {
  assert.equal(canonicIdToStateId('67d7cd6a-0000-2dff-933e-883d24f217d4'), '67d7cd6a-0000-2dff-933e-883d24f217d4');
  assert.equal(canonicIdToStateId('a.b c/d'), 'a_b_c_d');
  assert.equal(canonicIdToStateId('Ünïcode'), '_n_code');
});

test('canonicIdToStateId: never yields dots or an empty id', () => {
  assert.equal(canonicIdToStateId(''), 'unknown');
  assert.equal(canonicIdToStateId(undefined), 'unknown');
  assert.equal(canonicIdToStateId(null), 'unknown');
  assert.ok(!canonicIdToStateId('x.y.z').includes('.'));
});

test('describeDevice: describes a phone-like device without its name or ids', () => {
  const text = describeDevice({
    name: 'Maik private phone',
    manufacturer: 'Google',
    model: 'Pixel 8',
    deviceType: '1',
    raw: { identifierInformation: { type: 'IDENTIFIER_ANDROID', phoneInformation: {} } },
  });
  assert.equal(
    text,
    'manufacturer="Google", model="Pixel 8", deviceType=1, identifier=IDENTIFIER_ANDROID, phone information present',
  );
  assert.ok(!text.includes('Maik'));
});

test('describeDevice: copes with missing fields', () => {
  assert.equal(
    describeDevice({ raw: {} }),
    'manufacturer=unknown, model=unknown, deviceType=unknown, identifier=none',
  );
  assert.equal(describeDevice(undefined), 'manufacturer=unknown, model=unknown, deviceType=unknown, identifier=none');
});

test('describeDevice: adds the identifier field layout when known', () => {
  assert.equal(
    describeDevice({ identifierLayout: '2=5,3{1:len12}', raw: { identifierInformation: { type: 5 } } }),
    'manufacturer=unknown, model=unknown, deviceType=unknown, identifier=5, identifier fields: 2=5,3{1:len12}',
  );
});

test('describeDevice: reports an id outside the known fields by length only, plus the entry layout', () => {
  const text = describeDevice({
    otherCanonicId: '0b8f0d0e-1c2d-4e3f-8a9b-0c1d2e3f4a5b',
    entryLayout: '1{2=5},4{2:len18}',
    raw: { identifierInformation: { type: 5 } },
  });
  assert.equal(
    text,
    'manufacturer=unknown, model=unknown, deviceType=unknown, identifier=5, id outside the known fields: 36 chars, entry fields: 1{2=5},4{2:len18}',
  );
  assert.ok(!text.includes('0b8f'));
});

test('newestLocation: picks the report with the highest timestamp and skips empty entries', () => {
  const { newestLocation } = require('../lib/util');
  const a = { timestamp: 100 };
  const b = { timestamp: 300 };
  const c = { timestamp: 200 };
  assert.equal(newestLocation([a, null, b, undefined, c]), b);
  assert.equal(newestLocation([]), null);
  assert.equal(newestLocation([null]), null);
});

test('isOlderThanStored: only a strictly older report is skipped', () => {
  const { isOlderThanStored } = require('../lib/util');
  assert.equal(isOlderThanStored(2000000, { timestamp: 1000 }), true, 'older than stored');
  assert.equal(isOlderThanStored(1000000, { timestamp: 1000 }), false, 'same time is still written');
  assert.equal(isOlderThanStored(1000000, { timestamp: 2000 }), false, 'newer');
  assert.equal(isOlderThanStored(null, { timestamp: 1000 }), false, 'nothing stored yet');
  assert.equal(isOlderThanStored(0, { timestamp: 1000 }), false);
  assert.equal(isOlderThanStored('x', { timestamp: 1000 }), false);
});
