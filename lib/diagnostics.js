'use strict';

// Collects, per tracker, the facts that matter for compatibility reports:
// which device it is (manufacturer, model, type), what Google offers for it,
// what kind of location reports came back and how many could be read, and
// how requests ended. The report is meant to be copied into a bug report, so
// it never holds names, ids, positions or times of a position - only counts
// and model data. Trackers are numbered in the order they were first seen.

const STATUS_NAMES = ['SEMANTIC', 'LAST_KNOWN', 'CROWDSOURCED', 'AGGREGATED'];

/**
 * Sorts a reason why a report was skipped into a short category.
 *
 * @param {string} reason the error message
 * @returns {string} the category
 */
function categorizeSkip(reason) {
    const text = String(reason || '');
    const keyPart = /Unsupported key part length (\d+)/.exec(text);
    if (keyPart) {
        return `unsupported-key-part-${keyPart[1]}`;
    }
    if (/MAC check failed|authenticate|Unsupported state/i.test(text)) {
        return 'authentication-failed';
    }
    if (/valid (P-256|E2EE) public key/.test(text)) {
        return 'invalid-key-part';
    }
    if (/time of the report/.test(text)) {
        return 'bad-time';
    }
    if (/out of range/.test(text)) {
        return 'bad-coordinates';
    }
    if (/identity key/i.test(text)) {
        return 'identity-key';
    }
    return 'other';
}

/**
 * Counts one more of something.
 *
 * @param {Record<string, number>} map the counters
 * @param {string} key which counter
 */
function bump(map, key) {
    map[key] = (map[key] || 0) + 1;
}

/** The diagnostic facts of all trackers. */
class Diagnostics {
    /** Starts without any tracker. */
    constructor() {
        this.entries = new Map();
    }

    /**
     * Returns the record of a tracker, creating it on first use.
     *
     * @param {string} id Google's id of the tracker (only used as a key, never reported)
     * @returns {object} the record
     */
    _entry(id) {
        let entry = this.entries.get(id);
        if (!entry) {
            entry = {
                n: this.entries.size + 1,
                device: {},
                answers: 0,
                withoutReport: 0,
                reportTypes: {},
                origin: { ownDevice: 0, relayed: 0 },
                keyPartLengths: {},
                readings: {},
                skipped: {},
                newestReportAgeSeconds: { last: null, max: null },
                locateRequests: { ok: 0, retried: 0, timeout: 0, error: 0 },
                soundRequests: { start: 0, stop: 0, rejected: 0, error: 0 },
            };
            this.entries.set(id, entry);
        }
        return entry;
    }

    /**
     * Remembers what is known about the device itself.
     *
     * @param {string} id Google's id of the tracker
     * @param {{manufacturer?: string | null, model?: string | null, deviceType?: string | null, fastPairModelId?: string | null, identifierKind?: string, capabilities?: number[]}} info model data
     */
    setDevice(id, info) {
        this._entry(id).device = {
            manufacturer: info.manufacturer || null,
            model: info.model || null,
            deviceType: info.deviceType || null,
            fastPairModelId: info.fastPairModelId || null,
            identifierKind: info.identifierKind || null,
            capabilities: info.capabilities || [],
        };
    }

    /**
     * Records the newest readable report of one answer from Google.
     *
     * @param {string} id Google's id of the tracker
     * @param {{timestamp: number, status?: number, isOwnReport?: boolean, keyPartLength?: number, reading?: string | null, semantic?: string} | null} location the decrypted report, or null if the answer held none
     * @param {number} [nowSeconds] the current time, to work out how old the report is
     */
    recordAnswer(id, location, nowSeconds = Date.now() / 1000) {
        const entry = this._entry(id);
        entry.answers++;
        if (!location) {
            entry.withoutReport++;
            return;
        }
        bump(entry.reportTypes, STATUS_NAMES[location.status] || String(location.status));
        if (location.semantic === undefined) {
            bump(entry.origin, location.isOwnReport ? 'ownDevice' : 'relayed');
            if (location.keyPartLength !== undefined) {
                bump(entry.keyPartLengths, String(location.keyPartLength));
            }
            if (location.reading) {
                bump(entry.readings, location.reading);
            }
        }
        const age = Math.max(0, Math.round(nowSeconds - location.timestamp));
        const ages = entry.newestReportAgeSeconds;
        ages.last = age;
        ages.max = ages.max === null ? age : Math.max(ages.max, age);
    }

    /**
     * Records a report that could not be used.
     *
     * @param {string} id Google's id of the tracker
     * @param {{reason: string, keyPartLength?: number}} info why and (if known) the size of its key part
     */
    recordSkip(id, info) {
        bump(this._entry(id).skipped, categorizeSkip(info.reason));
    }

    /**
     * Records how a location request ended.
     *
     * @param {string} id Google's id of the tracker
     * @param {'ok' | 'retried' | 'timeout' | 'error'} outcome the result
     */
    recordLocate(id, outcome) {
        bump(this._entry(id).locateRequests, outcome);
    }

    /**
     * Records how a sound request ended.
     *
     * @param {string} id Google's id of the tracker
     * @param {'start' | 'stop' | 'rejected' | 'error'} outcome the result
     */
    recordSound(id, outcome) {
        bump(this._entry(id).soundRequests, outcome);
    }

    /**
     * Builds the report.
     *
     * @param {string} version the adapter version
     * @returns {object} the report, ready for JSON
     */
    report(version) {
        return {
            adapter: version || null,
            trackers: [...this.entries.values()].map(({ n, device, ...rest }) => ({ tracker: n, ...device, ...rest })),
        };
    }

    /**
     * Builds the report as text for a bug report.
     *
     * @param {string} version the adapter version
     * @returns {string} the report as JSON
     */
    reportJson(version) {
        return JSON.stringify(this.report(version));
    }
}

module.exports = { Diagnostics, categorizeSkip };
