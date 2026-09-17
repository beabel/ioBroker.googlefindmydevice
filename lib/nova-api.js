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
const DEVICE_TYPE_SPOT_DEVICE = 2;

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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Nova ListDevices failed: HTTP ${response.status} - ${text.slice(0, 300)}`);
  }

  const buf = Buffer.from(await response.arrayBuffer());
  const decoded = DevicesList.decode(buf);
  const obj = DevicesList.toObject(decoded, { longs: String, defaults: true });

  return (obj.deviceMetadata || []).map((device) => ({
    name: device.userDefinedDeviceName || '(unbenannt)',
    canonicId: device.identifierInformation?.canonicIds?.canonicId?.[0]?.id || null,
    raw: device,
  }));
}

module.exports = { listDevices };
