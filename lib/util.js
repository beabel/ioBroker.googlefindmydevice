'use strict';

// Pure helpers that don't depend on @iobroker/adapter-core, so they can be
// unit-tested without a running ioBroker installation.

// Fields js-controller auto-decrypts on every startup because they're
// listed in io-package.json's top-level encryptedNative.
const ENCRYPTED_NATIVE_FIELDS = ['oauthToken', 'aasToken', 'securityToken', 'sharedKeyJson', 'ownerKey'];

/**
 * Whether a decrypted encryptedNative value looks like garbage rather
 * than the real thing. Google's tokens are always plain printable ASCII,
 * ownerKey is always a hex string, and sharedKeyJson is always valid
 * JSON (or empty) - a value that was accidentally run through the
 * repeating-XOR legacy decrypt one extra time will practically always
 * fail one of these checks.
 *
 * @param {string} field one of ENCRYPTED_NATIVE_FIELDS
 * @param {string} value the (decrypted) value to check
 * @returns {boolean} true if the value looks corrupted
 */
function looksCorrupted(field, value) {
    if (!value) {
        return false;
    }
    if (field === 'ownerKey') {
        return !/^[0-9a-f]+$/i.test(value);
    }
    if (field === 'sharedKeyJson') {
        try {
            JSON.parse(value);
            return false;
        } catch {
            return true;
        }
    }
    // oauthToken, aasToken, securityToken: plain printable ASCII tokens
    return /[^\x20-\x7E]/.test(value);
}

/**
 * Clamps a user-configured interval (in minutes) into [min, max], falling
 * back to `fallback` for anything that isn't a positive number. Both bounds
 * matter: without the upper cap, a huge value overflows setTimeout's 32-bit
 * millisecond limit (~24.8 days) and the timer fires immediately in a loop.
 *
 * @param {unknown} value the raw configured value
 * @param {number} min lower bound in minutes
 * @param {number} max upper bound in minutes
 * @param {number} fallback value used when `value` is not a usable number
 * @returns {number} the clamped interval in minutes
 */
function clampMinutes(value, min, max, fallback) {
    return Math.min(max, Math.max(min, Number(value) || fallback));
}

/**
 * Turns a Google canonic device id into a valid ioBroker object id segment
 * (only A-Z, a-z, 0-9, "_" and "-" - stricter than ioBroker's own minimum).
 *
 * @param {unknown} raw the raw device id
 * @returns {string} the sanitized id segment
 */
function canonicIdToStateId(raw) {
    return String(raw || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * One-line description of a device for the debug log (phones, tablets and
 * headphones that are left out because Google gave them no tracker identifier,
 * and the trackers that are kept). It deliberately omits the user-defined name
 * and any ids.
 *
 * @param {{manufacturer?: string | null, model?: string | null, deviceType?: string | null,
 *   raw?: {identifierInformation?: {type?: string | number | null, phoneInformation?: unknown}},
 *   identifierLayout?: string, entryLayout?: string, otherCanonicId?: string | null}} device
 *   a device as returned by listDevices()
 * @returns {string} the description, e.g. `manufacturer="X", model="Y", deviceType=1, identifier=IDENTIFIER_ANDROID`
 */
function describeDevice(device) {
    const identifier = device?.raw?.identifierInformation;
    const parts = [
        `manufacturer=${device?.manufacturer ? `"${device.manufacturer}"` : 'unknown'}`,
        `model=${device?.model ? `"${device.model}"` : 'unknown'}`,
        `deviceType=${device?.deviceType ?? 'unknown'}`,
        `identifier=${identifier?.type ?? 'none'}`,
    ];
    if (identifier?.phoneInformation) {
        parts.push('phone information present');
    }
    if (device?.identifierLayout) {
        parts.push(`identifier fields: ${device.identifierLayout}`);
    }
    if (device?.otherCanonicId) {
        parts.push(`id outside the known fields: ${device.otherCanonicId.length} chars`);
    }
    if (device?.entryLayout) {
        parts.push(`entry fields: ${device.entryLayout}`);
    }
    return parts.join(', ');
}

/**
 * Picks the newest of several decrypted location reports.
 *
 * @param {Array<{timestamp: number} | null | undefined>} locations decrypted reports (empty entries are skipped)
 * @returns {object | null} the report with the highest timestamp, or null if there is none
 */
function newestLocation(locations) {
    let newest = null;
    for (const location of locations) {
        if (location && (!newest || location.timestamp > newest.timestamp)) {
            newest = location;
        }
    }
    return newest;
}

/**
 * Whether a report is older than the one already stored. Google answers
 * with a different subset of reports from one request to the next, so an
 * older report must never overwrite a newer one.
 *
 * @param {unknown} storedLastSeenMs the stored lastSeen value (epoch ms), if any
 * @param {{timestamp: number}} location the report that is about to be written (timestamp in seconds)
 * @returns {boolean} true if the report must be skipped
 */
function isOlderThanStored(storedLastSeenMs, location) {
    return typeof storedLastSeenMs === 'number' && storedLastSeenMs > 0 && location.timestamp * 1000 < storedLastSeenMs;
}

module.exports = {
    ENCRYPTED_NATIVE_FIELDS,
    looksCorrupted,
    clampMinutes,
    canonicIdToStateId,
    describeDevice,
    newestLocation,
    isOlderThanStored,
};
