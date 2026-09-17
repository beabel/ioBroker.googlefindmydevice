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

const NOVA_LIST_DEVICES_URL = 'https://android.googleapis.com/nova/nbe_list_devices';
const NOVA_EXECUTE_ACTION_URL = 'https://android.googleapis.com/nova/nbe_execute_action';
const DEVICE_TYPE_SPOT_DEVICE = 2;
const SPOT_CONTRIBUTOR_ALL_LOCATIONS = 2;
const HTTP_TIMEOUT_MS = 15000;

let protoRoot = null;

async function loadProto() {
  if (protoRoot) return protoRoot;
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

  return (obj.deviceMetadata || []).map((device) => {
    const registration = device.information?.deviceRegistration;
    return {
      name: device.userDefinedDeviceName || '(unbenannt)',
      canonicId: device.identifierInformation?.canonicIds?.canonicId?.[0]?.id || null,
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
      raw: device,
    };
  });
}

/**
 * Asks Google to actively ping a tracker for a fresh location ("locate
 * now"). The answer does not come back in the HTTP response - it arrives
 * asynchronously as an FCM push message (see mcs-client.js), correlated by
 * requestUuid. This is the network call that actually costs the tracker
 * battery/BLE traffic, unlike listDevices() which just reads Google's cache.
 *
 * @param {string} admToken - same scope as listDevices()
 * @param {{canonicId: string, fcmRegistrationId: string, requestUuid: string, fmdClientUuid: string}} params
 */
async function executeLocateAction(admToken, { canonicId, fcmRegistrationId, requestUuid, fmdClientUuid }) {
  const root = await loadProto();
  const ExecuteActionRequest = root.lookupType('googlefindmydevice.ExecuteActionRequest');

  const requestMsg = ExecuteActionRequest.create({
    scope: {
      type: DEVICE_TYPE_SPOT_DEVICE,
      device: { canonicId: { id: canonicId } },
    },
    action: {
      locateTracker: {
        lastHighTrafficEnablingTime: { seconds: Math.floor(Date.now() / 1000) },
        contributorType: SPOT_CONTRIBUTOR_ALL_LOCATIONS,
      },
    },
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
}

module.exports = { listDevices, executeLocateAction };
