'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { looksCorrupted, clampMinutes, canonicIdToStateId, ENCRYPTED_NATIVE_FIELDS } = require('../lib/util');

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
