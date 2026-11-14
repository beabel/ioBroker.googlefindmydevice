'use strict';

// Client for Google's Nova API (android.googleapis.com/nova/...), the plain
// REST/protobuf endpoint (as opposed to the gRPC-based Spot API) used to
// list Find Hub devices and their last-known location reports.
//
// Protocol reference: NovaApi/ListDevices/nbe_list_devices.py and
// NovaApi/nova_request.py in leonboe1/GoogleFindMyTools (GPL-3.0).

const path = require('node:path');
const crypto = require('node:crypto');
const protobuf = require('protobufjs');
const {
    describeIdentifierBlocks,
    describeDeviceEntries,
    findIdentifierIds,
    deviceEntries,
    fillAlternativeInformation,
    readCapabilities,
} = require('./proto-fields');

const NOVA_LIST_DEVICES_URL = 'https://android.googleapis.com/nova/nbe_list_devices';
const NOVA_EXECUTE_ACTION_URL = 'https://android.googleapis.com/nova/nbe_execute_action';
const DEVICE_TYPE_SPOT_DEVICE = 2;
const SPOT_CONTRIBUTOR_ALL_LOCATIONS = 2;
const HTTP_TIMEOUT_MS = 15000;

let protoRoot = null;

async function loadProto() {
    if (protoRoot) {
        return protoRoot;
    }
    protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'device_update.proto'));
    return protoRoot;
}

/**
 * Fetches the list of Find Hub devices (trackers) and their last-known
 * (still encrypted) location reports for the signed-in Google account.
 *
 * @param {string} admToken - a bearer token from google-auth.js's
 *   performOAuth(email, aasToken, androidId, 'android_device_manager',
 *   'com.google.android.apps.adm', ...)
 * @returns {Promise<Array<object>>} one entry per device, with the device
 *   name, its canonic id, and the raw (still protobuf/encrypted) location
 *   report data for later decryption.
 */
async function listDevices(admToken) {
    const root = await loadProto();
    const DevicesListRequest = root.lookupType('googlefindmydevice.DevicesListRequest');
    const DevicesList = root.lookupType('googlefindmydevice.DevicesList');

    const requestPayload = DevicesListRequest.create({
        deviceListRequestPayload: {
            type: DEVICE_TYPE_SPOT_DEVICE,
            id: crypto.randomUUID(),
        },
    });
    const body = DevicesListRequest.encode(requestPayload).finish();

    const response = await fetch(NOVA_LIST_DEVICES_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Authorization: `Bearer ${admToken}`,
            'Accept-Language': 'en-US',
            'User-Agent': 'fmd/20006320; gzip',
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Nova ListDevices failed: HTTP ${response.status} - ${text.slice(0, 300)}`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    const decoded = DevicesList.decode(buf);
    const obj = DevicesList.toObject(decoded, { longs: String, defaults: true, enums: String });

    // Unknown fields are dropped by the schema decode, so read the identifier
    // block's field layout from the raw bytes (for the debug log only).
    const identifierLayouts = describeIdentifierBlocks(buf);
    const entryLayouts = describeDeviceEntries(buf);
    const identifierIds = findIdentifierIds(buf);

    const DeviceInformation = root.lookupType('googlefindmydevice.DeviceInformation');
    const entries = deviceEntries(buf);

    return (obj.deviceMetadata || []).map((device, index) => {
        // Headphones carry their device information in another field (see
        // proto-fields.js); entries without it are phones and the like.
        const fastPair = fillAlternativeInformation(device, entries[index], DeviceInformation);
        const registration = device.information?.deviceRegistration;
        const ownCanonicId = device.identifierInformation?.canonicIds?.canonicId?.[0]?.id;
        const fastPairId =
            fastPair && registration?.encryptedUserSecrets?.encryptedIdentityKey?.length ? identifierIds[index] : null;
        return {
            name: device.userDefinedDeviceName || '(unbenannt)',
            canonicId: ownCanonicId || fastPairId || null,
            manufacturer: registration?.manufacturer || null,
            model: registration?.model || null,
            fastPairModelId: registration?.fastPairModelId || null,
            pairDate: registration?.pairDate || null,
            // enums:String only yields a name for values SpotDeviceType actually
            // declares - Google returns others too (e.g. 27), which toObject then
            // leaves as a bare number, so force it to a string either way.
            deviceType:
                registration?.deviceTypeInformation?.deviceType != null
                    ? String(registration.deviceTypeInformation.deviceType)
                    : null,
            // Count only, never the other accounts' emails themselves - see
            // main.js's updateDeviceMetadataStates().
            sharedWithCount: (device.information?.accessInformation || []).filter(a => !a.thisAccount).length,
            // Which actions Google offers for this device (30 locate, 31 and 32 sound).
            capabilities: readCapabilities(entries[index]),
            identifierLayout: identifierLayouts[index] || '',
            entryLayout: entryLayouts[index] || '',
            // A canonic id found in a field outside the schema (headphones, see
            // main.js); kept so such devices can be supported once it is known
            // what Google returns for them. Not used for anything yet.
            otherCanonicId: ownCanonicId ? null : identifierIds[index],
            raw: device,
        };
    });
}

/**
 * Asks Google for the current location of a tracker ("locate now"). The
 * answer does not come back in the HTTP response - it arrives asynchronously
 * as an FCM push message (see mcs-client.js), correlated by requestUuid.
 * Unlike listDevices() this request is what makes Google answer with its
 * location reports at all.
 *
 * @param {string} admToken - same scope as listDevices()
 * @param {{canonicId: string, fcmRegistrationId: string, requestUuid: string, fmdClientUuid: string}} params the
 *   tracker and the identifiers the asynchronous answer will be correlated by
 * @returns {Promise<Buffer>} the (undocumented) body of Google's answer
 */
async function executeLocateAction(admToken, params) {
    return sendExecuteAction(admToken, params, {
        locateTracker: {
            lastHighTrafficEnablingTime: { seconds: Math.floor(Date.now() / 1000) },
            contributorType: SPOT_CONTRIBUTOR_ALL_LOCATIONS,
        },
    });
}

/**
 * Makes a tracker play (or stop playing) its sound. Starting needs no
 * answer. A stop must carry the requestUuid of the start it belongs to
 * (Google matches them by it); without one the stop is sent anyway, but the
 * tracker may keep ringing until it stops by itself.
 *
 * @param {string} admToken - same scope as listDevices()
 * @param {{canonicId: string, fcmRegistrationId: string, requestUuid: string, fmdClientUuid: string}} params the
 *   tracker and the identifiers of the request (requestUuid may be empty for a stop without a known start)
 * @param {boolean} start - true to start the sound, false to stop it
 * @returns {Promise<Buffer>} the (undocumented) body of Google's answer
 */
async function executeSoundAction(admToken, params, start) {
    // An empty message is still sent (as a zero-length field): the field itself is the command.
    return sendExecuteAction(admToken, params, start ? { startSound: {} } : { stopSound: {} });
}

/**
 * Sends one ExecuteAction request to Nova.
 *
 * @param {string} admToken - same scope as listDevices()
 * @param {{canonicId: string, fcmRegistrationId: string, requestUuid: string, fmdClientUuid: string}} params the
 *   tracker and the identifiers of the request
 * @param {object} action the action part of the request (one ExecuteActionType field)
 * @returns {Promise<Buffer>} the (undocumented) body of Google's answer
 */
async function sendExecuteAction(admToken, { canonicId, fcmRegistrationId, requestUuid, fmdClientUuid }, action) {
    const root = await loadProto();
    const ExecuteActionRequest = root.lookupType('googlefindmydevice.ExecuteActionRequest');

    const requestMsg = ExecuteActionRequest.create({
        scope: {
            type: DEVICE_TYPE_SPOT_DEVICE,
            device: { canonicId: { id: canonicId } },
        },
        action,
        requestMetadata: {
            type: DEVICE_TYPE_SPOT_DEVICE,
            requestUuid,
            fmdClientUuid,
            gcmRegistrationId: { id: fcmRegistrationId },
            unknown: true,
        },
    });
    const body = ExecuteActionRequest.encode(requestMsg).finish();

    const response = await fetch(NOVA_EXECUTE_ACTION_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Authorization: `Bearer ${admToken}`,
            'Accept-Language': 'en-US',
            'User-Agent': 'fmd/20006320; gzip',
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Nova ExecuteAction failed: HTTP ${response.status} - ${text.slice(0, 300)}`);
    }
    // The answer is not documented. Hand it back so the caller can log its
    // structure (field numbers and sizes only) at debug level.
    return typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
}

module.exports = { listDevices, executeLocateAction, executeSoundAction };
