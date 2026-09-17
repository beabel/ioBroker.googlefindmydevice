'use strict';

// Decrypts a "aesgcm" content-encoding Web Push payload (the legacy
// draft-httpbis-encryption-encoding-02 scheme FCM's MCS channel still uses
// for data messages), given our own EC key pair/auth secret and the sender's
// ephemeral public key + salt from the message. Ports the relevant part of
// the `http-ece` Python library (MIT,
// https://github.com/martinthomson/encrypted-content-encoding, (c) Martin
// Thomson) used by leonboe1/GoogleFindMyTools (GPL-3.0) for the same purpose.

const crypto = require('node:crypto');

function lengthPrefixed(buf) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(buf.length, 0);
    return Buffer.concat([len, buf]);
}

function hkdf(ikm, salt, info, length) {
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * @param {Buffer} payload - the DataMessageStanza's raw_data
 * @param {Buffer} salt - from the "encryption" app_data entry ("salt=...")
 * @param {Buffer} senderPublicKey - from the "crypto-key" app_data entry ("dh=..."), 65-byte uncompressed EC point
 * @param {Buffer} authSecret - our own secret, generated at FCM registration time
 * @param {Buffer} ecdhPrivateKey - our own EC private key, generated at FCM registration time
 * @param {Buffer} ecdhPublicKey - our own EC public key (65-byte uncompressed point)
 * @returns {Buffer} the decrypted plaintext
 */
function decryptAesGcmWebPush(payload, salt, senderPublicKey, authSecret, ecdhPrivateKey, ecdhPublicKey) {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(ecdhPrivateKey);
    const sharedSecret = ecdh.computeSecret(senderPublicKey);

    // "receiver" is us (we're decrypting), "sender" is whoever encrypted this for us.
    const context = Buffer.concat([
        Buffer.from('P-256\0'),
        lengthPrefixed(ecdhPublicKey),
        lengthPrefixed(senderPublicKey),
    ]);

    const authInfo = Buffer.from('Content-Encoding: auth\0');
    const secret = hkdf(sharedSecret, authSecret, authInfo, 32);

    const keyInfo = Buffer.concat([Buffer.from('Content-Encoding: aesgcm\0'), context]);
    const nonceInfo = Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), context]);

    const key = hkdf(secret, salt, keyInfo, 16);
    const nonceBase = hkdf(secret, salt, nonceInfo, 12);

    if (payload.length <= 16) {
        throw new Error('Web Push payload too short.');
    }

    // Single-record message (counter=0, so the nonce is used unmodified).
    const ciphertext = payload.subarray(0, payload.length - 16);
    const tag = payload.subarray(payload.length - 16);

    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonceBase);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const pad = decrypted.readUInt16BE(0);
    if (2 + pad > decrypted.length) {
        throw new Error('Web Push payload: invalid padding.');
    }
    return decrypted.subarray(2 + pad);
}

module.exports = { decryptAesGcmWebPush };
