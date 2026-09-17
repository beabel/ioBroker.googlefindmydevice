'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fmdn = require('../lib/fmdn-crypto');

// Known-answer vectors cross-checked against an independent Python
// re-implementation of the same algorithm (using pycryptodomex/ecdsa/
// cryptography) that itself round-trips correctly. See DOKU/ or the
// project history for how these were derived.

test('generateEid matches known vector (32-byte-aligned message)', () => {
  const idKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const timestamp = 8704000;
  const eid = fmdn.generateEid(idKey, timestamp);
  assert.equal(eid.toString('hex'), '9d8188455646a1b02ef769bf9845f095c1e79499');
});

test('encrypt/decrypt round-trip and match known vector (32-byte message)', () => {
  const idKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const timestamp = 8704000;
  const message = Buffer.from('Hello FMDN JS port! 0123456789AB', 'utf8');
  const randomS = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));

  const eid = fmdn.generateEid(idKey, timestamp);
  const { encryptedAndTag, Sx } = fmdn.encrypt(message, randomS, eid);

  assert.equal(
    encryptedAndTag.toString('hex'),
    '5df30b087854b00fb264958a150770c314b9cd81eff891a846f61ed0c4b4a74b5497608711fc5186d0ced5c8d6bfa228',
  );
  assert.equal(Sx.toString('hex'), '92038871819a59e7eee4011b8bff4b55dd3cd5d3');

  const decrypted = fmdn.decrypt(idKey, encryptedAndTag, Sx, timestamp);
  assert.deepEqual(decrypted, message);
});

test('encrypt/decrypt round-trip with a non-block-aligned message', () => {
  const idKey = Buffer.from('030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc', 'hex');
  const timestamp = 1758000000;
  const message = Buffer.from('lat:52.5200,lon:13.4050', 'utf8'); // 23 bytes, not a multiple of 16
  const randomS = Buffer.from('010e1b2835424f5c697683909daab7c4d1deebf805121f2c394653606d7a8794', 'hex');

  const eid = fmdn.generateEid(idKey, timestamp);
  assert.equal(eid.toString('hex'), '85c98e079a2b8df8bc226cf20deebeaae1484314');

  const { encryptedAndTag, Sx } = fmdn.encrypt(message, randomS, eid);
  assert.equal(
    encryptedAndTag.toString('hex'),
    'bbc512a1acd58f8e4d887ddaa1139f25fc87d2c60b90b69b60f56e7ed7df1a66ad358e0a9270c5',
  );
  assert.equal(Sx.toString('hex'), '182e1e7821caa7286708a3a33145f157d6ef4f50');

  const decrypted = fmdn.decrypt(idKey, encryptedAndTag, Sx, timestamp);
  assert.deepEqual(decrypted, message);
});

test('decrypt rejects a tampered tag', () => {
  const idKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const timestamp = 8704000;
  const message = Buffer.from('Hello FMDN JS port! 0123456789AB', 'utf8');
  const randomS = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));

  const eid = fmdn.generateEid(idKey, timestamp);
  const { encryptedAndTag, Sx } = fmdn.encrypt(message, randomS, eid);

  const tampered = Buffer.from(encryptedAndTag);
  tampered[tampered.length - 1] ^= 0xff;

  assert.throws(() => fmdn.decrypt(idKey, tampered, Sx, timestamp), /MAC check failed/);
});

test('calculateTruncatedSha256 derives distinct recovery/ringing/tracking keys', () => {
  const idKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const recovery = fmdn.calculateTruncatedSha256(idKey, 0x01);
  const ringing = fmdn.calculateTruncatedSha256(idKey, 0x02);
  const tracking = fmdn.calculateTruncatedSha256(idKey, 0x03);

  assert.equal(recovery.toString('hex'), '8b44d96f214304bc');
  assert.equal(ringing.toString('hex'), '5728705214326174');
  assert.equal(tracking.toString('hex'), '944c533876f9de37');
});
