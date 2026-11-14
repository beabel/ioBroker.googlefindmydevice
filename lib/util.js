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

// A report may be stamped slightly ahead of this machine's clock; beyond that it is not plausible.
const MAX_REPORT_FUTURE_DRIFT_S = 600;
const DEFAULT_SEMANTIC_RADIUS_M = 100;

const REPORT_STATUS_NAMES = ['SEMANTIC', 'LAST_KNOWN', 'CROWDSOURCED', 'AGGREGATED'];

// What Google calls the user's home place in the languages of the adapter (compared in lower case).
const HOME_NAMES = new Set([
    'home',
    'zuhause',
    'zu hause',
    'maison',
    'domicile',
    'casa',
    'hogar',
    'thuis',
    'dom',
    'дом',
    'дім',
    '家',
]);

/**
 * Whether a place name reported by Google is the user's home place.
 *
 * @param {unknown} name the place name
 * @returns {boolean} true for "Home" and its translations
 */
function isHomeName(name) {
    return HOME_NAMES.has(
        String(name || '')
            .trim()
            .toLowerCase(),
    );
}

/**
 * Reads the position the user entered in the ioBroker system settings.
 *
 * @param {{common?: {latitude?: unknown, longitude?: unknown}} | null | undefined} systemConfig the object system.config
 * @returns {{lat: number, lon: number} | null} the coordinates, or null if they are not set or not valid
 */
function systemCoordinates(systemConfig) {
    const common = (systemConfig && systemConfig.common) || {};
    if (!isCoordinate(common.latitude, 90) || !isCoordinate(common.longitude, 180)) {
        return null;
    }
    return { lat: Number(common.latitude), lon: Number(common.longitude) };
}

/**
 * Describes the newest report of one answer for the debug log: its time,
 * type and origin and how many reports the answer held. No coordinates.
 *
 * @param {{timestamp: number, status?: number, isOwnReport?: boolean, reportCount?: number, semantic?: string}} location the decrypted report
 * @returns {string} a short description
 */
function describeAnswer(location) {
    const parts = [`newest report from ${new Date(location.timestamp * 1000).toISOString()}`];
    if (location.status !== undefined) {
        parts.push(`type ${REPORT_STATUS_NAMES[location.status] || location.status}`);
    }
    if (location.semantic === undefined && location.isOwnReport !== undefined) {
        parts.push(location.isOwnReport ? 'uploaded by one of your own devices' : 'relayed by another device');
    }
    if (location.reportCount !== undefined) {
        parts.push(`${location.reportCount} report(s) in the answer`);
    }
    return `${parts[0]} (${parts.slice(1).join(', ')})`;
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
 * @param {number} [nowMs] the current time in ms (for the future check)
 * @returns {boolean} true if the report must be skipped
 */
function isOlderThanStored(storedLastSeenMs, location, nowMs = Date.now()) {
    if (typeof storedLastSeenMs !== 'number' || storedLastSeenMs <= 0) {
        return false;
    }
    // A stored time far in the future is bogus; it must never block the real reports.
    if (storedLastSeenMs > nowMs + MAX_REPORT_FUTURE_DRIFT_S * 1000) {
        return false;
    }
    return location.timestamp * 1000 < storedLastSeenMs;
}

/**
 * Turns the time of a location report into whole seconds since 1970.
 * Accepts seconds, milliseconds or microseconds, as a number, a numeric string
 * or a protobuf time object ({seconds}).
 *
 * @param {unknown} time the raw time of the report
 * @param {number} [nowSeconds] the current time in seconds (for the future check)
 * @returns {number | null} seconds, or null if the time is missing, invalid or lies in the future
 */
function normalizeReportTime(time, nowSeconds = Date.now() / 1000) {
    const raw = time && typeof time === 'object' && 'seconds' in time ? time.seconds : time;
    let seconds = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    if (seconds > 1e15) {
        seconds /= 1e6;
    } else if (seconds > 1e12) {
        seconds /= 1e3;
    }
    seconds = Math.floor(seconds);
    return seconds > nowSeconds + MAX_REPORT_FUTURE_DRIFT_S ? null : seconds;
}

function isCoordinate(value, limit) {
    if (value === null || value === undefined || value === '') {
        return false;
    }
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit;
}

/**
 * Looks up the coordinates the user assigned to a semantic place name.
 *
 * @param {unknown} rows the "Named places" table from the configuration
 * @param {string} name the place name reported by Google (compared ignoring case and surrounding spaces)
 * @returns {{lat: number, lon: number, radius: number} | null} the coordinates and radius in metres, or null if none are set
 */
function findSemanticMapping(rows, name) {
    const key = String(name || '')
        .trim()
        .toLowerCase();
    if (!key || !Array.isArray(rows)) {
        return null;
    }
    for (const row of rows) {
        if (
            !row ||
            String(row.name || '')
                .trim()
                .toLowerCase() !== key
        ) {
            continue;
        }
        if (!isCoordinate(row.latitude, 90) || !isCoordinate(row.longitude, 180)) {
            continue;
        }
        const radius = Number(row.radius);
        return {
            lat: Number(row.latitude),
            lon: Number(row.longitude),
            radius: Number.isFinite(radius) && radius > 0 ? Math.min(radius, 100000) : DEFAULT_SEMANTIC_RADIUS_M,
        };
    }
    return null;
}

module.exports = {
    ENCRYPTED_NATIVE_FIELDS,
    looksCorrupted,
    clampMinutes,
    canonicIdToStateId,
    describeDevice,
    newestLocation,
    isOlderThanStored,
    normalizeReportTime,
    findSemanticMapping,
    describeAnswer,
    isHomeName,
    systemCoordinates,
    MAX_REPORT_FUTURE_DRIFT_S,
};
