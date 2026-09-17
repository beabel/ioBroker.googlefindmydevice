'use strict';

// Performs an anonymous GCM "checkin" - the same request every Chrome
// browser/Android device periodically sends to Google - to obtain a fresh
// (androidId, securityToken) pair. This identity is required as an input to
// the gpsoauth token-exchange calls in google-auth.js; it is not itself tied
// to any Google account or app identity.
//
// Protocol reference: Auth/firebase_messaging/fcmregister.py in
// leonboe1/GoogleFindMyTools (GPL-3.0) and the equivalent gcm.ts in
// eneris/push-receiver (MIT) - both implement the same long-public checkin
// protocol used by many unofficial GCM/FCM clients.

const path = require('path');
const protobuf = require('protobufjs');

const CHECKIN_URL = 'https://android.clients.google.com/checkin';

let checkinRoot = null;

async function loadProto() {
  if (checkinRoot) return checkinRoot;
  checkinRoot = await protobuf.load(path.join(__dirname, 'proto', 'checkin.proto'));
  return checkinRoot;
}

/**
 * @param {{androidId?: string, securityToken?: string}} [existing] - re-checkin with a known identity
 * @returns {Promise<{androidId: string, securityToken: string}>}
 */
async function gcmCheckin(existing = {}) {
  const root = await loadProto();
  const AndroidCheckinRequest = root.lookupType('checkin_proto.AndroidCheckinRequest');
  const AndroidCheckinResponse = root.lookupType('checkin_proto.AndroidCheckinResponse');

  const payload = {
    userSerialNumber: 0,
    version: 3,
    checkin: {
      type: 3, // DEVICE_CHROME_BROWSER
      chromeBuild: {
        platform: 3, // PLATFORM_LINUX
        chromeVersion: '63.0.3234.0',
        channel: 1, // CHANNEL_STABLE
      },
    },
  };
  if (existing.androidId) payload.id = existing.androidId;
  if (existing.securityToken) payload.securityToken = existing.securityToken;

  const errMsg = AndroidCheckinRequest.verify(payload);
  if (errMsg) throw new Error('Invalid checkin request: ' + errMsg);

  const message = AndroidCheckinRequest.create(payload);
  const body = AndroidCheckinRequest.encode(message).finish();

  const response = await fetch(CHECKIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-protobuf' },
    body,
  });

  if (!response.ok) {
    throw new Error(`GCM checkin failed: HTTP ${response.status}`);
  }

  const responseBuf = Buffer.from(await response.arrayBuffer());
  const decoded = AndroidCheckinResponse.decode(responseBuf);
  const obj = AndroidCheckinResponse.toObject(decoded, { longs: String });

  if (!obj.androidId || !obj.securityToken) {
    throw new Error('GCM checkin response missing androidId/securityToken');
  }

  return { androidId: obj.androidId, securityToken: obj.securityToken };
}

module.exports = { gcmCheckin };
