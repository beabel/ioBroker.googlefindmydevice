'use strict';

// FMDN (Find My Device Network) E2EE crypto: EID generation, ECIES-style
// location encryption/decryption, and owner-key derivation.
//
// Ported to Node.js (using only the built-in `crypto` module and native
// BigInt - no third-party crypto dependency) from the algorithm described in
// leonboe1/GoogleFindMyTools (FMDNCrypto/*.py), a GPL-3.0-licensed,
// independently reverse-engineered client for Google's undocumented Find
// Hub / Find My Device protocol: https://github.com/leonboe1/GoogleFindMyTools
//
// This file is licensed GPL-3.0 (see LICENSE), consistent with that origin.

const crypto = require('crypto');

// secp160r1 (SEC2) domain parameters
const P = 0xffffffffffffffffffffffffffffffff7fffffffn;
const A = 0xffffffffffffffffffffffffffffffff7ffffffcn;
const B = 0x1c97befc54bd7a8b65acf89f81d4d4adc565fa45n;
const N = 0x0100000000000000000001f4c8f927aed3ca752257n; // curve order
const CURVE_NAME = 'secp160r1';

function modpow(base, exp, mod) {
  base %= mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function bufToBigIntUnsigned(buf) {
  return BigInt('0x' + buf.toString('hex'));
}

function bufToBigIntSigned(buf) {
  let v = bufToBigIntUnsigned(buf);
  const bits = BigInt(buf.length * 8);
  if (v >= (1n << (bits - 1n))) v -= (1n << bits);
  return v;
}

function bigIntToBuf(v, len) {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let buf = Buffer.from(hex, 'hex');
  if (buf.length < len) {
    buf = Buffer.concat([Buffer.alloc(len - buf.length, 0), buf]);
  } else if (buf.length > len) {
    buf = buf.subarray(buf.length - len);
  }
  return buf;
}

// Given only the X coordinate of a curve point, recover a valid Y (even Y, per FMDN convention)
function rxToRy(Rx) {
  const Ryy = mod(Rx ** 3n + A * Rx + B, P);
  let Ry = modpow(Ryy, (P + 1n) / 4n, P);
  if (mod(Ry * Ry, P) !== Ryy) {
    throw new Error("The provided EID isn't a valid E2EE public key.");
  }
  if (Ry % 2n !== 0n) Ry = P - Ry;
  return Ry;
}

function pointToUncompressedBuf(x, y) {
  return Buffer.concat([Buffer.from([0x04]), bigIntToBuf(x, 20), bigIntToBuf(y, 20)]);
}

// Scalar multiplication of the curve generator: returns 20-byte X of (scalar * G)
function scalarMultGenerator(scalar) {
  const ecdh = crypto.createECDH(CURVE_NAME);
  ecdh.setPrivateKey(bigIntToBuf(mod(scalar, N), 21));
  const pub = ecdh.getPublicKey(); // 0x04 || X(20) || Y(20)
  return pub.subarray(1, 21);
}

// Scalar multiplication of an arbitrary point (given as 20-byte X, reconstructing Y via rxToRy):
// returns 20-byte X of (scalar * point)
function scalarMultPoint(scalar, pointXBuf) {
  const Px = bufToBigIntUnsigned(pointXBuf);
  const Py = rxToRy(Px);
  const ecdh = crypto.createECDH(CURVE_NAME);
  ecdh.setPrivateKey(bigIntToBuf(mod(scalar, N), 21));
  const secret = ecdh.computeSecret(pointToUncompressedBuf(Px, Py));
  return secret; // Node returns just the X coordinate (20 bytes) for this curve
}

const K = 10; // rotation exponent: 2^K second EID rotation period

function getMaskedTimestamp(timestamp) {
  const masked = timestamp & ~((1 << K) - 1);
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(masked >>> 0, 0);
  return buf;
}

function aesEcbEncryptBlock(key, block) {
  const algo = key.length === 32 ? 'aes-256-ecb' : 'aes-128-ecb';
  const cipher = crypto.createCipheriv(algo, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

function calculateR(identityKey, timestamp) {
  const tsBytes = getMaskedTimestamp(timestamp);
  const data = Buffer.alloc(32, 0);
  data.fill(0xff, 0, 11);
  data[11] = K;
  tsBytes.copy(data, 12);
  // bytes 16..27 already zero
  data[27] = K;
  tsBytes.copy(data, 28);

  const rDash = aesEcbEncryptBlock(identityKey, data);
  const rDashInt = bufToBigIntUnsigned(rDash);
  return mod(rDashInt, N);
}

function generateEid(identityKey, timestamp) {
  const r = calculateR(identityKey, timestamp);
  return scalarMultGenerator(r);
}

// ---- AES-EAX (RFC-style: OMAC1/CMAC-based tweakable MAC + CTR) ----

function xorBuf(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function shiftLeft1(buf) {
  const out = Buffer.alloc(buf.length);
  let carry = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    const val = (buf[i] << 1) | carry;
    out[i] = val & 0xff;
    carry = (val >> 8) & 1;
  }
  return { out, carry };
}

function generateSubkeys(key) {
  const zero = Buffer.alloc(16, 0);
  const L = aesEcbEncryptBlock(key, zero);
  const Rb = 0x87;
  const s1 = shiftLeft1(L);
  const K1 = s1.out;
  if (s1.carry) K1[15] ^= Rb;
  const s2 = shiftLeft1(K1);
  const K2 = s2.out;
  if (s2.carry) K2[15] ^= Rb;
  return { K1, K2 };
}

function cmac(key, message) {
  const { K1, K2 } = generateSubkeys(key);
  const blockSize = 16;
  const nBlocks = Math.max(1, Math.ceil(message.length / blockSize));
  const lastComplete = message.length > 0 && message.length % blockSize === 0;

  let padded;
  if (lastComplete) {
    padded = Buffer.from(message);
  } else {
    const padLen = blockSize - (message.length % blockSize) - 1;
    padded = Buffer.concat([message, Buffer.from([0x80]), Buffer.alloc(padLen, 0)]);
  }

  let x = Buffer.alloc(16, 0);
  for (let i = 0; i < nBlocks; i++) {
    let block = padded.subarray(i * blockSize, (i + 1) * blockSize);
    if (i === nBlocks - 1) {
      block = xorBuf(block, lastComplete ? K1 : K2);
    }
    x = aesEcbEncryptBlock(key, xorBuf(x, block));
  }
  return x;
}

function omac(key, tweak, message) {
  const tweakBlock = Buffer.alloc(16, 0);
  tweakBlock[15] = tweak;
  return cmac(key, Buffer.concat([tweakBlock, message]));
}

function ctrCrypt(key, counterBlock, data) {
  const cipher = crypto.createCipheriv('aes-256-ctr', key, counterBlock);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function eaxEncrypt(key, nonce, header, plaintext) {
  const Nprime = omac(key, 0, nonce);
  const Hprime = omac(key, 1, header);
  const ciphertext = ctrCrypt(key, Nprime, plaintext);
  const Cprime = omac(key, 2, ciphertext);
  const tag = xorBuf(xorBuf(Nprime, Hprime), Cprime);
  return { ciphertext, tag };
}

function eaxDecrypt(key, nonce, header, ciphertext, tag) {
  const Nprime = omac(key, 0, nonce);
  const Hprime = omac(key, 1, header);
  const Cprime = omac(key, 2, ciphertext);
  const expectedTag = xorBuf(xorBuf(Nprime, Hprime), Cprime);
  if (!crypto.timingSafeEqual(expectedTag, tag)) {
    throw new Error('MAC check failed');
  }
  return ctrCrypt(key, Nprime, ciphertext); // CTR is its own inverse
}

// ---- Public FMDN encrypt/decrypt (mirrors foreign_tracker_cryptor.py) ----

function encrypt(message, randomBuf, eidBuf) {
  const s = mod(bufToBigIntSigned(randomBuf), N);
  const Sx = scalarMultGenerator(s);
  const sharedX = scalarMultPoint(s, eidBuf); // (s*R)x, R reconstructed from eid
  const k = crypto.hkdfSync('sha256', sharedX, Buffer.alloc(0), Buffer.alloc(0), 32);
  const kBuf = Buffer.from(k);

  const LRx = eidBuf.subarray(12, 20); // lower 8 bytes of 20-byte X coordinate
  const LSx = Sx.subarray(12, 20);
  const nonce = Buffer.concat([LRx, LSx]);

  const { ciphertext, tag } = eaxEncrypt(kBuf, nonce, Buffer.alloc(0), message);
  return { encryptedAndTag: Buffer.concat([ciphertext, tag]), Sx };
}

function decrypt(identityKey, encryptedAndTag, Sx, beaconTimeCounter) {
  const mDash = encryptedAndTag.subarray(0, encryptedAndTag.length - 16);
  const tag = encryptedAndTag.subarray(encryptedAndTag.length - 16);

  const r = calculateR(identityKey, beaconTimeCounter);
  const Rx = scalarMultGenerator(r);
  const sharedX = scalarMultPoint(r, Sx); // (r*S)x, S reconstructed from Sx
  const k = crypto.hkdfSync('sha256', sharedX, Buffer.alloc(0), Buffer.alloc(0), 32);
  const kBuf = Buffer.from(k);

  const LRx = Rx.subarray(12, 20);
  const LSx = Sx.subarray(12, 20);
  const nonce = Buffer.concat([LRx, LSx]);

  return eaxDecrypt(kBuf, nonce, Buffer.alloc(0), mDash, tag);
}

function calculateTruncatedSha256(identityKey, operation) {
  const data = Buffer.concat([identityKey, Buffer.from([operation])]);
  return crypto.createHash('sha256').update(data).digest().subarray(0, 8);
}

module.exports = {
  generateEid,
  calculateR,
  encrypt,
  decrypt,
  calculateTruncatedSha256,
};
