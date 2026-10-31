'use strict';

// Current BLE identifiers (EIDs) of a tracker, for the optional "publish EID"
// states. Pure functions without any adapter-core dependency, so they can be
// unit-tested. A tracker broadcasts a 20-byte EID in its FMDN advertisement
// (Eddystone service 0xFEAA, frame type 0x40/0x41) and changes it every
// 2^10 = 1024 seconds; only the owner (who holds the identity key) can compute
// it. The identity key itself never leaves this module's callers' memory.

const { generateEid, EID_ROTATION_SECONDS } = require('./fmdn-crypto');

const VALID_KEY_LENGTHS = [16, 32];

/**
 * Computes the EID of the rotation window containing `nowMs` and of the two
 * neighbouring windows (the tracker's clock may deviate from ours, so a
 * scanner should accept all three).
 *
 * @param {Buffer | null | undefined} identityKey the tracker's identity key
 * @param {number} nowMs the current time in milliseconds since the epoch
 * @returns {{current: string, previous: string, next: string, windowStart: number, windowSeconds: number} | null}
 *   the EIDs as 40-character hex strings, the start of the current window in
 *   epoch milliseconds and the window length; null if there is no usable key
 */
function computeEidWindows(identityKey, nowMs) {
    if (!Buffer.isBuffer(identityKey) || !VALID_KEY_LENGTHS.includes(identityKey.length)) {
        return null;
    }
    const windowStart = Math.floor(nowMs / 1000 / EID_ROTATION_SECONDS) * EID_ROTATION_SECONDS;
    const eidAt = seconds => generateEid(identityKey, seconds).toString('hex');
    return {
        previous: eidAt(windowStart - EID_ROTATION_SECONDS),
        current: eidAt(windowStart),
        next: eidAt(windowStart + EID_ROTATION_SECONDS),
        windowStart: windowStart * 1000,
        windowSeconds: EID_ROTATION_SECONDS,
    };
}

/**
 * Milliseconds until the next rotation window starts (never 0).
 *
 * @param {number} nowMs the current time in milliseconds since the epoch
 * @returns {number} the delay in milliseconds
 */
function msUntilNextWindow(nowMs) {
    const windowMs = EID_ROTATION_SECONDS * 1000;
    return windowMs - (nowMs % windowMs);
}

module.exports = { computeEidWindows, msUntilNextWindow };
