'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p256 = require('../lib/fmdn-p256');

const IDENTITY_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const RANDOM = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const COUNTER = 8_704_000;
const MESSAGE = Buffer.from('a location report');

test('a report of a P-256 tracker is decrypted for every scalar derivation and nonce length', () => {
  for (const derivation of ['be_mod_n', 'be_plus_one', 'le_plus_one']) {
    for (const half of [8, 10]) {
      const eid = p256.generateEid(IDENTITY_KEY, COUNTER, derivation);
      assert.equal(eid.length, 32);
      const { encryptedAndTag, Sx } = p256.encrypt(MESSAGE, RANDOM, eid, half);
      assert.equal(Sx.length, 32);

      const result = p256.decrypt(IDENTITY_KEY, encryptedAndTag, Sx, COUNTER);
      assert.deepEqual(result.plaintext, MESSAGE, `${derivation}/${half}`);
      assert.equal(result.reading, `p256/${derivation}/nonce${half}`);
    }
  }
});

test('the specification reading is found first', () => {
  const eid = p256.generateEid(IDENTITY_KEY, COUNTER);
  const { encryptedAndTag, Sx } = p256.encrypt(MESSAGE, RANDOM, eid);
  assert.equal(p256.decrypt(IDENTITY_KEY, encryptedAndTag, Sx, COUNTER).reading, 'p256/be_mod_n/nonce8');
});

test('a wrong identity key, a wrong time counter or a tampered report is rejected, never decrypted wrongly', () => {
  const eid = p256.generateEid(IDENTITY_KEY, COUNTER);
  const { encryptedAndTag, Sx } = p256.encrypt(MESSAGE, RANDOM, eid);

  assert.throws(() => p256.decrypt(Buffer.alloc(32, 9), encryptedAndTag, Sx, COUNTER), /MAC check failed/);
  assert.throws(() => p256.decrypt(IDENTITY_KEY, encryptedAndTag, Sx, COUNTER + 4096), /MAC check failed/);
  const tampered = Buffer.from(encryptedAndTag);
  tampered[2] ^= 0xff;
  assert.throws(() => p256.decrypt(IDENTITY_KEY, tampered, Sx, COUNTER), /MAC check failed/);
});

test('a key part with the wrong size, a short report or a point that is not on the curve fails clearly', () => {
  const eid = p256.generateEid(IDENTITY_KEY, COUNTER);
  const { encryptedAndTag } = p256.encrypt(MESSAGE, RANDOM, eid);
  assert.throws(
    () => p256.decrypt(IDENTITY_KEY, encryptedAndTag, Buffer.alloc(20, 1), COUNTER),
    /Unsupported key part length 20/,
  );
  assert.throws(() => p256.decrypt(IDENTITY_KEY, Buffer.alloc(5), Buffer.alloc(32, 1), COUNTER), /too short/);

  let sawInvalid = false;
  for (let i = 1; i < 40 && !sawInvalid; i++) {
    try {
      p256.decrypt(IDENTITY_KEY, encryptedAndTag, Buffer.alloc(32, i), COUNTER);
    } catch (err) {
      sawInvalid = /valid P-256 public key/.test(err.message);
    }
  }
  assert.ok(sawInvalid, 'an x coordinate that is not on the curve is recognised');
});
