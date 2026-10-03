'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSharedKeyFromVaultKeys, buildEncryptionUnlockUrl, CONSOLE_SNIPPET } = require('../lib/owner-key');

test('extracts the finder_hw key bytes from the pasted vault keys', () => {
  const pasted = JSON.stringify({ finder_hw: [{ key: { 0: 1, 1: 2, 2: 255 } }] });
  assert.deepEqual(extractSharedKeyFromVaultKeys(pasted), Buffer.from([1, 2, 255]));
});

test('rejects text that is not JSON with a helpful message', () => {
  assert.throws(() => extractSharedKeyFromVaultKeys('this is not json'), /not valid JSON/);
  assert.throws(() => extractSharedKeyFromVaultKeys(''), /not valid JSON/);
});

test('rejects JSON that has no finder_hw key', () => {
  assert.throws(() => extractSharedKeyFromVaultKeys('{}'), /No "finder_hw" key/);
  assert.throws(() => extractSharedKeyFromVaultKeys('{"finder_hw":[]}'), /No "finder_hw" key/);
  assert.throws(() => extractSharedKeyFromVaultKeys('{"finder_hw":"x"}'), /No "finder_hw" key/);
});

test('the unlock link points at Google and carries a fresh session each time', async () => {
  const first = await buildEncryptionUnlockUrl();
  const second = await buildEncryptionUnlockUrl();
  assert.match(first, /^https:\/\/accounts\.google\.com\/encryption\/unlock\/android\?kdi=/);
  assert.notEqual(first, second);
});

test('the browser-console snippet is a non-empty script', () => {
  assert.equal(typeof CONSOLE_SNIPPET, 'string');
  assert.ok(CONSOLE_SNIPPET.length > 50);
});
