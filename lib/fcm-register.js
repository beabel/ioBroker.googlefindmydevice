'use strict';

// Registers a virtual "device" with Firebase Cloud Messaging so Google can
// push us the answer to a "locate now" request (see nova-api.js's
// executeLocateAction() and mcs-client.js). Ports the registration half of
// the `firebase-messaging` Python library (MIT,
// https://github.com/sdb9696/firebase-messaging, (c) 2017 Matthieu Lemoine,
// (c) 2023 Steven Beth), which leonboe1/GoogleFindMyTools (GPL-3.0) vendors
// and uses for the same purpose - field names/URLs below come from that
// library's fcmregister.py.
//
// Unlike that reference (which performs its own separate GCM checkin to get
// a dedicated push-only android_id), this reuses the androidId/securityToken
// already established for the main Google account login (google-checkin.js
// produces the same "Chrome browser" checkin identity), since on a real
// device both roles are the same physical android_id anyway.

const crypto = require('node:crypto');

const GCM_REGISTER_URL = 'https://android.clients.google.com/c2dm/register3';
const FCM_INSTALLATION_URL = 'https://firebaseinstallations.googleapis.com/v1/';
const FCM_REGISTRATION_URL = 'https://fcmregistrations.googleapis.com/v1/';
const FCM_SEND_URL = 'https://fcm.googleapis.com/fcm/send/';
const GCM_SERVER_KEY_B64 =
    'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoM' + 'j8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';
const AUTH_VERSION = 'FIS_v2';
const SDK_VERSION = 'w:0.6.6';

// Google's own "Find My Device" Android app's public Firebase project -
// the same for every user, not a secret tied to any account.
const FMD_FCM_PROJECT_ID = 'google.com:api-project-289722593072';
const FMD_FCM_APP_ID = '1:289722593072:android:3cfcf5bc359f0308';
const FMD_FCM_API_KEY = 'AIzaSyD_gko3P392v6how2H7UpdeXQ0v2HLettc';
const FMD_ANDROID_PACKAGE = 'com.google.android.apps.adm';
const HTTP_TIMEOUT_MS = 15000;

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateKeys() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        ecdhPrivateKey: ecdh.getPrivateKey(),
        ecdhPublicKey: ecdh.getPublicKey(), // 65-byte uncompressed point
        authSecret: crypto.randomBytes(16),
    };
}

async function gcmRegister(androidId, securityToken) {
    const gcmAppId = `wp:${FMD_ANDROID_PACKAGE}#${crypto.randomUUID()}`;

    const body = new URLSearchParams({
        app: 'org.chromium.linux',
        'X-subtype': gcmAppId,
        device: androidId,
        sender: GCM_SERVER_KEY_B64,
    });

    const response = await fetch(GCM_REGISTER_URL, {
        method: 'POST',
        headers: {
            Authorization: `AidLogin ${androidId}:${securityToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok || text.includes('Error')) {
        throw new Error(`GCM register3 failed: ${text.slice(0, 200)}`);
    }

    const token = text.split('=')[1];
    return { gcmToken: token, gcmAppId };
}

async function fcmInstall(clientSig) {
    const fid = crypto.randomBytes(17);
    fid[0] = 0b01110000 + (fid[0] % 0b00010000); // FID header bits, see fcmregister.py

    const hbHeader = Buffer.from(JSON.stringify({ heartbeats: [], version: 2 })).toString('base64');

    const response = await fetch(`${FCM_INSTALLATION_URL}projects/${FMD_FCM_PROJECT_ID}/installations`, {
        method: 'POST',
        headers: {
            'x-firebase-client': hbHeader,
            'x-goog-api-key': FMD_FCM_API_KEY,
            'X-Android-Package': FMD_ANDROID_PACKAGE,
            'X-Android-Cert': clientSig,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            appId: FMD_FCM_APP_ID,
            authVersion: AUTH_VERSION,
            fid: base64url(fid),
            sdkVersion: SDK_VERSION,
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`FCM install failed: HTTP ${response.status} - ${(await response.text()).slice(0, 200)}`);
    }

    const json = await response.json();
    return { installToken: json.authToken.token };
}

async function fcmRegister(gcmToken, keys, installToken, clientSig) {
    const response = await fetch(`${FCM_REGISTRATION_URL}projects/${FMD_FCM_PROJECT_ID}/registrations`, {
        method: 'POST',
        headers: {
            'x-goog-api-key': FMD_FCM_API_KEY,
            'x-goog-firebase-installations-auth': installToken,
            'X-Android-Package': FMD_ANDROID_PACKAGE,
            'X-Android-Cert': clientSig,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            web: {
                applicationPubKey: null,
                auth: base64url(keys.authSecret),
                endpoint: FCM_SEND_URL + gcmToken,
                p256dh: base64url(keys.ecdhPublicKey),
            },
        }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`FCM register failed: HTTP ${response.status} - ${(await response.text()).slice(0, 200)}`);
    }

    const json = await response.json();
    if (!json.token) {
        throw new Error('FCM register: response did not contain a token.');
    }
    return json.token;
}

/**
 * Registers a fresh FCM push subscription tied to the existing GCM device
 * identity, so Google can asynchronously push us the answer to a "locate
 * now" request.
 *
 * @param {{androidId: string, securityToken: string, clientSig?: string}} identity
 * @returns {Promise<{fcmToken: string, gcmAppId: string, ecdhPrivateKey: Buffer,
 *   ecdhPublicKey: Buffer, authSecret: Buffer}>}
 */
async function registerFcm({ androidId, securityToken, clientSig = '38918a453d07199354f8b19af05ec6562ced5788' }) {
    const keys = generateKeys();
    const { gcmToken, gcmAppId } = await gcmRegister(androidId, securityToken);
    const { installToken } = await fcmInstall(clientSig);
    const fcmToken = await fcmRegister(gcmToken, keys, installToken, clientSig);

    return { fcmToken, gcmAppId, ...keys };
}

module.exports = { registerFcm };
