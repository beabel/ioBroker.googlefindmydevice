'use strict';

// Decrypts a device's most recent location report, once the E2EE owner key
// is available (see owner-key.js). Ports the relevant parts of
// NovaApi/ExecuteAction/LocateTracker/decrypt_locations.py from
// leonboe1/GoogleFindMyTools (GPL-3.0).

const crypto = require('node:crypto');
const path = require('node:path');
const protobuf = require('protobufjs');
const fmdn = require('./fmdn-crypto');
const { normalizeReportTime } = require('./util');

const MCU_FAST_PAIR_MODEL_ID = '003200';
const STATUS_SEMANTIC = 0;
// Length of the sender key part (Sx) of a relayed report: the SECP160R1 curve of the FMDN specification.
const SUPPORTED_KEY_PART_LENGTH = 20;

function flipBits(data, enabled) {
    if (!enabled) {
        return data;
    }
    const out = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        out[i] = data[i] ^ 0xff;
    }
    return out;
}

function toBuffer(v) {
    if (!v) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(v)) {
        return v;
    }
    if (typeof v === 'string') {
        return Buffer.from(v, 'base64');
    }
    return Buffer.from(v);
}

function decryptAesCbcNoPadding(key, encryptedDataAndIv, ivLength = 16) {
    const iv = encryptedDataAndIv.subarray(0, ivLength);
    const ciphertext = encryptedDataAndIv.subarray(ivLength);
    const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc';
    const decipher = crypto.createDecipheriv(algo, key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptAesGcm(key, encryptedDataAndIv, ivLength = 12) {
    const iv = encryptedDataAndIv.subarray(0, ivLength);
    const rest = encryptedDataAndIv.subarray(ivLength);
    const tag = rest.subarray(rest.length - 16);
    const ciphertext = rest.subarray(0, rest.length - 16);
    const algo = key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm';
    const decipher = crypto.createDecipheriv(algo, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptEik(ownerKey, encryptedEik) {
    if (encryptedEik.length === 48) {
        return decryptAesCbcNoPadding(ownerKey, encryptedEik);
    }
    if (encryptedEik.length === 60) {
        return decryptAesGcm(ownerKey, encryptedEik);
    }
    throw new Error(`Unexpected length of the encrypted identity key: ${encryptedEik.length}`);
}

/**
 * Whether a device is an MCU-type tracker (fixed Fast Pair model id), which keeps a constant beacon counter.
 *
 * @param {{fastPairModelId?: string}} deviceRegistration the raw device registration record
 * @returns {boolean} true for MCU trackers
 */
function isMcuTracker(deviceRegistration) {
    return deviceRegistration.fastPairModelId === MCU_FAST_PAIR_MODEL_ID;
}

/**
 * Unwraps a device's per-device identity key from its registration record,
 * reversing the bit-flipping and AES-GCM wrapping Google applies before
 * returning it from the device-listing API.
 *
 * @param {Buffer} ownerKey the account owner key used to decrypt the wrapped identity key
 * @param {object} deviceRegistration the raw device registration record from nova-api.js's listDevices()
 * @returns {Buffer} the device's identity key
 */
function retrieveIdentityKey(ownerKey, deviceRegistration) {
    const isMcu = isMcuTracker(deviceRegistration);
    const secrets = deviceRegistration.encryptedUserSecrets;
    if (!secrets || !secrets.encryptedIdentityKey) {
        throw new Error('No encrypted identity key present for this device.');
    }
    const flipped = flipBits(toBuffer(secrets.encryptedIdentityKey), isMcu);
    return decryptEik(ownerKey, flipped);
}

let protoRoot = null;
async function loadProto() {
    if (protoRoot) {
        return protoRoot;
    }
    protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'device_update.proto'));
    return protoRoot;
}

/**
 * Decrypts the most recent location report for one device (as returned by
 * nova-api.js's listDevices(), which keeps the raw protobuf-derived object
 * under `.raw`). Every report is tried on its own, newest first: one that
 * cannot be read (for example because it uses a key format that is not
 * supported) is skipped, so an older report that can be read is still used.
 *
 * @param {Buffer} ownerKey the account owner key used to decrypt the device's identity key
 * @param {object} device the device entry returned by nova-api.js's listDevices()
 * @param {{onSkip?: (info: {reason: string, keyPartLength?: number, ownReport?: boolean}) => void}} [options]
 *   onSkip is called for every report that is left out, with the reason (never the content)
 * @returns {Promise<null | {semantic: string, timestamp: number, status: number, reportCount: number} |
 *   {lat: number, lon: number, altitude: number, timestamp: number, isOwnReport: boolean, accuracy: number,
 *   status: number, reportCount: number}>}
 *   the decrypted location (with the type of the report and the number of reports in the answer), or null if the device has no location report yet.
 *   Throws the first error if reports exist but none of them could be decrypted.
 */
async function decryptLatestLocation(ownerKey, device, options = {}) {
    const onSkip = options.onSkip || (() => {});
    const root = await loadProto();
    const LocationType = root.lookupType('googlefindmydevice.Location');

    const deviceRegistration = device.raw && device.raw.information && device.raw.information.deviceRegistration;
    if (!deviceRegistration) {
        return null;
    }

    const reports =
        device.raw &&
        device.raw.information &&
        device.raw.information.locationInformation &&
        device.raw.information.locationInformation.reports &&
        device.raw.information.locationInformation.reports.recentLocationAndNetworkLocations;
    if (!reports) {
        return null;
    }

    const nowSeconds = Date.now() / 1000;
    const candidates = [];
    const addCandidate = (loc, time) => {
        const timestamp = normalizeReportTime(time, nowSeconds);
        if (timestamp === null) {
            onSkip({ reason: 'missing or implausible time of the report' });
            return;
        }
        candidates.push({ loc, timestamp });
    };
    if (reports.recentLocation && Object.keys(reports.recentLocation).length > 0) {
        addCandidate(reports.recentLocation, reports.recentLocationTimestamp);
    }
    const networkLocations = reports.networkLocations || [];
    const networkTimestamps = reports.networkLocationTimestamps || [];
    networkLocations.forEach((loc, i) => addCandidate(loc, networkTimestamps[i]));

    candidates.sort((a, b) => b.timestamp - a.timestamp);

    let identityKey = null;
    let firstError = null;
    for (const { loc, timestamp } of candidates) {
        if (Number(loc.status) === STATUS_SEMANTIC) {
            return {
                semantic: (loc.semanticLocation && loc.semanticLocation.locationName) || '',
                timestamp,
                status: STATUS_SEMANTIC,
                reportCount: candidates.length,
            };
        }

        const report = loc.geoLocation && loc.geoLocation.encryptedReport;
        if (!report || !report.encryptedLocation) {
            continue;
        }

        // Account-wide problems (wrong owner key, no identity key) are not a
        // property of one report - they are raised, not skipped.
        if (!identityKey) {
            identityKey = retrieveIdentityKey(ownerKey, deviceRegistration);
        }
        const encryptedLocation = toBuffer(report.encryptedLocation);
        const publicKeyRandom = toBuffer(report.publicKeyRandom);
        // Own reports carry no sender key; the way a report decrypts is the
        // reliable sign of where it came from (Google's own flag is not).
        const ownReport = publicKeyRandom.length === 0;

        try {
            let decrypted;
            if (ownReport) {
                // Keyed by a hash of the identity key, no ECDH involved.
                const identityKeyHash = crypto.createHash('sha256').update(identityKey).digest();
                decrypted = decryptAesGcm(identityKeyHash, encryptedLocation);
            } else {
                if (publicKeyRandom.length !== SUPPORTED_KEY_PART_LENGTH) {
                    throw new Error(
                        `Unsupported key part length ${publicKeyRandom.length} (only ${SUPPORTED_KEY_PART_LENGTH} bytes are supported)`,
                    );
                }
                const beaconTimeCounter = isMcuTracker(deviceRegistration)
                    ? 0
                    : Number(loc.geoLocation.deviceTimeOffset || 0);
                decrypted = fmdn.decrypt(identityKey, encryptedLocation, publicKeyRandom, beaconTimeCounter);
            }

            const locMsg = LocationType.decode(decrypted);
            const locObj = LocationType.toObject(locMsg, { defaults: true });
            const lat = locObj.latitude / 1e7;
            const lon = locObj.longitude / 1e7;
            if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
                throw new Error('Decrypted coordinates are out of range');
            }

            return {
                lat,
                lon,
                altitude: locObj.altitude,
                timestamp,
                isOwnReport: ownReport,
                accuracy: Number(loc.geoLocation.accuracy || 0),
                status: Number(loc.status),
                reportCount: candidates.length,
            };
        } catch (err) {
            firstError = firstError || err;
            onSkip({ reason: err.message, keyPartLength: publicKeyRandom.length, ownReport });
        }
    }

    if (firstError) {
        throw firstError;
    }
    return null;
}

module.exports = { decryptLatestLocation, retrieveIdentityKey, isMcuTracker };
