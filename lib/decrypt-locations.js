'use strict';

// Decrypts a device's most recent location report, once the E2EE owner key
// is available (see owner-key.js). Ports the relevant parts of
// NovaApi/ExecuteAction/LocateTracker/decrypt_locations.py from
// leonboe1/GoogleFindMyTools (GPL-3.0).

const crypto = require('node:crypto');
const path = require('node:path');
const protobuf = require('protobufjs');
const fmdn = require('./fmdn-crypto');

const MCU_FAST_PAIR_MODEL_ID = '003200';
const STATUS_SEMANTIC = 0;

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

function isMcuTracker(deviceRegistration) {
    return deviceRegistration.fastPairModelId === MCU_FAST_PAIR_MODEL_ID;
}

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
 * under `.raw`).
 *
 * @param {Buffer} ownerKey
 * @param {object} device
 * @returns {Promise<null | {semantic: string, timestamp: number} |
 *   {lat: number, lon: number, altitude: number, timestamp: number, isOwnReport: boolean}>}
 */
async function decryptLatestLocation(ownerKey, device) {
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

    const candidates = [];
    if (reports.recentLocation && Object.keys(reports.recentLocation).length > 0) {
        candidates.push({ loc: reports.recentLocation, time: reports.recentLocationTimestamp });
    }
    const networkLocations = reports.networkLocations || [];
    const networkTimestamps = reports.networkLocationTimestamps || [];
    networkLocations.forEach((loc, i) => candidates.push({ loc, time: networkTimestamps[i] }));

    if (candidates.length === 0) {
        return null;
    }

    candidates.sort((a, b) => Number((b.time && b.time.seconds) || 0) - Number((a.time && a.time.seconds) || 0));
    const { loc, time } = candidates[0];
    const timestamp = Number((time && time.seconds) || 0);

    if (Number(loc.status) === STATUS_SEMANTIC) {
        return { semantic: (loc.semanticLocation && loc.semanticLocation.locationName) || '', timestamp };
    }

    const report = loc.geoLocation && loc.geoLocation.encryptedReport;
    if (!report || !report.encryptedLocation) {
        return null;
    }

    const identityKey = retrieveIdentityKey(ownerKey, deviceRegistration);
    const encryptedLocation = toBuffer(report.encryptedLocation);
    const publicKeyRandom = toBuffer(report.publicKeyRandom);

    let decrypted;
    if (publicKeyRandom.length === 0) {
        // Own report: keyed by a hash of the identity key, no ECDH involved.
        const identityKeyHash = crypto.createHash('sha256').update(identityKey).digest();
        decrypted = decryptAesGcm(identityKeyHash, encryptedLocation);
    } else {
        const isMcu = isMcuTracker(deviceRegistration);
        const beaconTimeCounter = isMcu ? 0 : Number(loc.geoLocation.deviceTimeOffset || 0);
        decrypted = fmdn.decrypt(identityKey, encryptedLocation, publicKeyRandom, beaconTimeCounter);
    }

    const locMsg = LocationType.decode(decrypted);
    const locObj = LocationType.toObject(locMsg, { defaults: true });

    return {
        lat: locObj.latitude / 1e7,
        lon: locObj.longitude / 1e7,
        altitude: locObj.altitude,
        timestamp,
        isOwnReport: !!report.isOwnReport,
        accuracy: Number(loc.geoLocation.accuracy || 0),
    };
}

module.exports = { decryptLatestLocation, retrieveIdentityKey };
