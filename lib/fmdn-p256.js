'use strict';

// Decryption of relayed location reports from trackers that use the P-256
// curve (the second curve of the Find Hub Network accessory specification,
// 32-byte public key parts) instead of SECP160R1 (20 bytes, see
// fmdn-crypto.js).
//
// There is no public test vector for P-256 reports, and the sources disagree
// on two details, so several readings are tried until the authentication tag
// of the report verifies. A wrong reading never produces a wrong location,
// it only fails the tag check:
//   - how the 32-byte output r' of the identity-key PRF becomes the scalar r
//     (big-endian mod n as in the specification, "(r' mod (n-1)) + 1", or
//     the same with r' read little-endian), and
//   - how many bytes of the two x coordinates form the nonce (8 or 10).
//
// Sources: Find Hub Network accessory specification ("EID computation") and
// Boettger et al., "Okay Google, Where's My Tracker?", PoPETs 2025(4),
// section 4.1.5. The set of readings follows the one tried by
// BSkando/GoogleFindMy-HA (GPL-3.0), written here from scratch.
//
// This file is licensed GPL-3.0 (see LICENSE).

const crypto = require('node:crypto');
const fmdn = require('./fmdn-crypto');

const { bufToBigIntUnsigned, bigIntToBuf, modpow, mod, calculateRPrime, eaxEncrypt, eaxDecrypt } = fmdn.internals;

// NIST P-256 (secp256r1) domain parameters
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n; // curve order
const CURVE_NAME = 'prime256v1';
const COORD_LEN = 32;

const DERIVATIONS = [
    { id: 'be_mod_n', scalar: rPrime => bufToBigIntUnsigned(rPrime) % N },
    { id: 'be_plus_one', scalar: rPrime => (bufToBigIntUnsigned(rPrime) % (N - 1n)) + 1n },
    { id: 'le_plus_one', scalar: rPrime => (bufToBigIntUnsigned(Buffer.from(rPrime).reverse()) % (N - 1n)) + 1n },
];
const NONCE_HALVES = [8, 10];

/**
 * Recovers the even y coordinate of a P-256 point from its x coordinate.
 *
 * @param {bigint} x the x coordinate
 * @returns {bigint} the even y coordinate
 */
function xToY(x) {
    const yy = mod(x ** 3n + A * x + B, P);
    let y = modpow(yy, (P + 1n) / 4n, P);
    if (mod(y * y, P) !== yy) {
        throw new Error("The provided key part isn't a valid P-256 public key.");
    }
    if (y % 2n !== 0n) {
        y = P - y;
    }
    return y;
}

/**
 * x coordinate of scalar * G.
 *
 * @param {bigint} scalar the scalar, 1 .. n-1
 * @returns {Buffer} the 32-byte x coordinate
 */
function generatorX(scalar) {
    const ecdh = crypto.createECDH(CURVE_NAME);
    ecdh.setPrivateKey(bigIntToBuf(scalar, COORD_LEN));
    return ecdh.getPublicKey().subarray(1, 1 + COORD_LEN);
}

/**
 * x coordinate of scalar * point, the point given by its x coordinate (even y).
 *
 * @param {bigint} scalar the scalar, 1 .. n-1
 * @param {Buffer} pointX the 32-byte x coordinate of the point
 * @returns {Buffer} the 32-byte x coordinate of the result
 */
function pointMultX(scalar, pointX) {
    const x = bufToBigIntUnsigned(pointX);
    const y = xToY(x);
    const ecdh = crypto.createECDH(CURVE_NAME);
    ecdh.setPrivateKey(bigIntToBuf(scalar, COORD_LEN));
    return ecdh.computeSecret(
        Buffer.concat([Buffer.from([0x04]), bigIntToBuf(x, COORD_LEN), bigIntToBuf(y, COORD_LEN)]),
    );
}

function aesKey(sharedX) {
    return Buffer.from(crypto.hkdfSync('sha256', sharedX, Buffer.alloc(0), Buffer.alloc(0), 32));
}

/**
 * Decrypts a relayed location report of a P-256 tracker.
 *
 * @param {Buffer} identityKey the tracker's identity key (32 bytes)
 * @param {Buffer} encryptedAndTag ciphertext followed by the 16-byte tag
 * @param {Buffer} Sx the sender's public x coordinate (32 bytes)
 * @param {number} beaconTimeCounter beacon time counter of the report
 * @returns {{plaintext: Buffer, reading: string}} the plaintext and the reading that verified, e.g. "p256/be_mod_n/nonce8"
 */
function decrypt(identityKey, encryptedAndTag, Sx, beaconTimeCounter) {
    if (Sx.length !== COORD_LEN) {
        throw new Error(`Unsupported key part length ${Sx.length} for P-256`);
    }
    if (encryptedAndTag.length < 16) {
        throw new Error('The encrypted report is too short.');
    }
    xToY(bufToBigIntUnsigned(Sx)); // fails early for a key part that is not on the curve

    const mDash = encryptedAndTag.subarray(0, encryptedAndTag.length - 16);
    const tag = encryptedAndTag.subarray(encryptedAndTag.length - 16);
    const rPrime = calculateRPrime(identityKey, beaconTimeCounter);

    for (const derivation of DERIVATIONS) {
        const scalar = derivation.scalar(rPrime);
        if (scalar === 0n) {
            continue; // 0 * G is the point at infinity, this reading cannot apply
        }
        const Rx = generatorX(scalar);
        const key = aesKey(pointMultX(scalar, Sx));
        for (const half of NONCE_HALVES) {
            const nonce = Buffer.concat([Rx.subarray(COORD_LEN - half), Sx.subarray(COORD_LEN - half)]);
            try {
                return {
                    plaintext: eaxDecrypt(key, nonce, Buffer.alloc(0), mDash, tag),
                    reading: `p256/${derivation.id}/nonce${half}`,
                };
            } catch {
                // this reading does not fit, try the next one
            }
        }
    }
    throw new Error('MAC check failed (no P-256 reading matched)');
}

/**
 * The tracker's x coordinate (EID) for one rotation period. Used by the tests.
 *
 * @param {Buffer} identityKey the tracker's identity key
 * @param {number} beaconTimeCounter beacon time counter
 * @param {string} [derivationId] which scalar derivation the tracker uses
 * @returns {Buffer} the 32-byte x coordinate
 */
function generateEid(identityKey, beaconTimeCounter, derivationId = 'be_mod_n') {
    const derivation = DERIVATIONS.find(d => d.id === derivationId);
    return generatorX(derivation.scalar(calculateRPrime(identityKey, beaconTimeCounter)));
}

/**
 * Encrypts a message for a tracker's EID the way a finder device does. Used by the tests.
 *
 * @param {Buffer} message the plaintext
 * @param {Buffer} randomBuf random bytes the ephemeral scalar is derived from
 * @param {Buffer} eid the tracker's 32-byte x coordinate
 * @param {number} [nonceHalf] bytes of each x coordinate that form the nonce
 * @returns {{encryptedAndTag: Buffer, Sx: Buffer}} ciphertext with tag, and the sender's public x coordinate
 */
function encrypt(message, randomBuf, eid, nonceHalf = 8) {
    const s = (bufToBigIntUnsigned(randomBuf) % (N - 1n)) + 1n;
    const Sx = generatorX(s);
    const key = aesKey(pointMultX(s, eid));
    const nonce = Buffer.concat([eid.subarray(COORD_LEN - nonceHalf), Sx.subarray(COORD_LEN - nonceHalf)]);
    const { ciphertext, tag } = eaxEncrypt(key, nonce, Buffer.alloc(0), message);
    return { encryptedAndTag: Buffer.concat([ciphertext, tag]), Sx };
}

module.exports = { decrypt, generateEid, encrypt, COORD_LEN };
