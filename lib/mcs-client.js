'use strict';

// Persistent client for Google's Mobile Connection Server (MCS) - the TLS
// push channel FCM notifications are actually delivered over. A "locate
// now" request (nova-api.js's executeLocateAction()) only tells Google to
// ask the tracker for a fresh location; the answer arrives asynchronously as
// a push message on this connection, correlated by the request's UUID.
//
// Ports the MCS half of the `firebase-messaging` Python library (MIT,
// https://github.com/sdb9696/firebase-messaging), which
// leonboe1/GoogleFindMyTools (GPL-3.0) uses for the same purpose - wire
// framing, login fields and heartbeat handling below follow that library's
// fcmpushclient.py. The MCS protocol itself (mcs.proto) is public Chromium
// protocol, not anything reverse-engineered.

const tls = require('node:tls');
const path = require('node:path');
const protobuf = require('protobufjs');
const { decryptAesGcmWebPush } = require('./webpush-decrypt');

const MCS_HOST = 'mtalk.google.com';
const MCS_PORT = 5228;
const MCS_VERSION = 41;
const RECONNECT_DELAY_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_CHECK_MS = 5000;

const TAG_TO_TYPE = {
    0: 'HeartbeatPing',
    1: 'HeartbeatAck',
    2: 'LoginRequest',
    3: 'LoginResponse',
    4: 'Close',
    7: 'IqStanza',
    8: 'DataMessageStanza',
    10: 'StreamErrorStanza',
};
const TYPE_TO_TAG = {
    HeartbeatPing: 0,
    HeartbeatAck: 1,
    LoginRequest: 2,
    LoginResponse: 3,
    Close: 4,
    IqStanza: 7,
    DataMessageStanza: 8,
    StreamErrorStanza: 10,
};
const MCS_SELECTIVE_ACK_ID = 12;

/**
 * Encodes an unsigned 32-bit integer as a protobuf varint.
 *
 * @param {number} value the number to encode
 * @returns {Buffer} the varint bytes
 */
function encodeVarint32(value) {
    const bytes = [];
    let x = value >>> 0;
    do {
        let b = x & 0x7f;
        x >>>= 7;
        if (x !== 0) {
            b |= 0x80;
        }
        bytes.push(b);
    } while (x !== 0);
    return Buffer.from(bytes);
}

/**
 * Decodes a base64url string (as used in FCM's crypto-key/encryption headers).
 *
 * @param {string} str the base64url text
 * @returns {Buffer} the decoded bytes
 */
function b64urlToBuffer(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Persistent MCS push client; see the file header for what it is used for. */
class McsClient {
    /**
     * Creates the client. Everything the client needs from the adapter
     * (logging and timers) is injected, so it never touches the raw Node
     * timer globals and stays independent of adapter-core.
     *
     * @param {object} options constructor options
     * @param {{debug: (msg: string) => void, info: (msg: string) => void, warn: (msg: string) => void,
     *   error: (msg: string) => void}} options.log the adapter's logger
     * @param {{setTimeout: (fn: () => void, ms: number) => ioBroker.Timeout, clearTimeout: (timer: ioBroker.Timeout) => void,
     *   setInterval: (fn: () => void, ms: number) => ioBroker.Interval, clearInterval: (timer: ioBroker.Interval) => void}} options.timers
     *   the adapter's timer functions (cleaned up automatically when the adapter stops)
     */
    constructor({ log, timers }) {
        this.log = log;
        this._timers = timers;
        this._root = null;
        this._socket = null;
        this._identity = null;
        this._stopped = true;
        this._firstMessageSent = true;
        this._firstMessageReceived = true;
        this._recvBuf = Buffer.alloc(0);
        this._loggedIn = false;
        this._lastMessageTime = 0;
        this._heartbeatTimer = null;
        this._pending = new Map(); // requestUuid -> {resolve, reject, timeout}
    }

    /**
     * Loads (once) the MCS protocol definition.
     *
     * @returns {Promise<protobuf.Root>} the parsed protobuf root
     */
    async _loadProto() {
        if (!this._root) {
            this._root = await protobuf.load(path.join(__dirname, 'proto', 'mcs.proto'));
        }
        return this._root;
    }

    /**
     * Loads (once) the definition of the decrypted DeviceUpdate payload.
     *
     * @returns {Promise<protobuf.Root>} the parsed protobuf root
     */
    async _loadDeviceUpdateProto() {
        if (!this._deviceUpdateRoot) {
            this._deviceUpdateRoot = await protobuf.load(path.join(__dirname, 'proto', 'device_update.proto'));
        }
        return this._deviceUpdateRoot;
    }

    /**
     * Opens the persistent connection and logs in. Reconnects automatically
     * (with a fixed delay) until stop() is called.
     *
     * @param {{androidId: string, securityToken: string, gcmAppId: string,
     *   ecdhPrivateKey: Buffer, ecdhPublicKey: Buffer, authSecret: Buffer}} identity the registered FCM identity
     *   (GCM credentials plus the keys needed to decrypt pushed messages)
     */
    async start(identity) {
        this._identity = identity;
        this._stopped = false;
        await this._loadProto();
        await this._loadDeviceUpdateProto();
        this._connect();
    }

    /**
     * Closes the connection, cancels all timers and rejects every pending
     * location request. No reconnect is attempted afterwards.
     */
    stop() {
        this._stopped = true;
        if (this._heartbeatTimer) {
            this._timers.clearInterval(this._heartbeatTimer);
        }
        if (this._socket) {
            this._socket.destroy();
        }
        for (const { reject, timeout } of this._pending.values()) {
            this._timers.clearTimeout(timeout);
            reject(new Error('MCS connection was closed.'));
        }
        this._pending.clear();
    }

    /**
     * Whether the MCS login has completed on the current connection.
     *
     * @returns {boolean} true while logged in
     */
    isLoggedIn() {
        return this._loggedIn;
    }

    /**
     * Resolves with the decoded DeviceUpdate object whose fcmMetadata.requestUuid
     * matches, or rejects if nothing arrives within timeoutMs.
     *
     * @param {string} requestUuid the UUID sent with the locate request
     * @param {number} timeoutMs how long to wait before giving up
     * @returns {Promise<object>} the decoded DeviceUpdate message
     */
    waitForDeviceUpdate(requestUuid, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timeout = this._timers.setTimeout(() => {
                this._pending.delete(requestUuid);
                reject(new Error('Timed out waiting for the location push message.'));
            }, timeoutMs);
            this._pending.set(requestUuid, { resolve, reject, timeout });
        });
    }

    /** Opens the TLS connection and wires up data/error/close handling. */
    _connect() {
        if (this._stopped) {
            return;
        }

        this._firstMessageSent = true;
        this._firstMessageReceived = true;
        this._recvBuf = Buffer.alloc(0);
        this._loggedIn = false;

        this._socket = tls.connect({ host: MCS_HOST, port: MCS_PORT, servername: MCS_HOST }, () => {
            this.log.debug('MCS: TLS connection established, sending login...');
            this._login();
        });

        this._socket.on('data', chunk => {
            this._recvBuf = Buffer.concat([this._recvBuf, chunk]);
            this._parseBuffer();
        });

        this._socket.on('error', err => {
            this.log.debug(`MCS connection error: ${err.message}`);
        });

        this._socket.on('close', () => {
            this._loggedIn = false;
            if (this._heartbeatTimer) {
                this._timers.clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
            if (!this._stopped) {
                this._timers.setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
            }
        });
    }

    /**
     * Encodes and sends one MCS message.
     *
     * @param {string} typeName MCS message type, e.g. "LoginRequest"
     * @param {object} payload the message fields
     */
    _send(typeName, payload) {
        const Type = this._root.lookupType(`mcs_proto.${typeName}`);
        const errMsg = Type.verify(payload);
        if (errMsg) {
            throw new Error(`MCS ${typeName} invalid: ${errMsg}`);
        }
        const msg = Type.create(payload);
        const buf = Type.encode(msg).finish();
        const tag = TYPE_TO_TAG[typeName];
        const header = this._firstMessageSent ? Buffer.from([MCS_VERSION, tag]) : Buffer.from([tag]);
        this._firstMessageSent = false;
        this._socket.write(Buffer.concat([header, encodeVarint32(buf.length), buf]));
    }

    /** Sends the MCS login request using the registered identity. */
    _login() {
        const { androidId, securityToken } = this._identity;
        this._send('LoginRequest', {
            id: 'ioBroker.googlefindmydevice',
            domain: 'mcs.android.com',
            user: String(androidId),
            resource: String(androidId),
            authToken: String(securityToken),
            deviceId: `android-${BigInt(androidId).toString(16)}`,
            networkType: 1,
            useRmq2: true,
            authService: 2, // ANDROID_ID
            setting: [{ name: 'new_vc', value: '1' }],
            receivedPersistentId: [],
            heartbeatStat: { ip: '', timeout: true, intervalMs: 10000 },
        });
    }

    /** Splits the receive buffer into complete frames and dispatches each one. */
    _parseBuffer() {
        for (;;) {
            const prefixLen = this._firstMessageReceived ? 2 : 1;
            if (this._recvBuf.length < prefixLen) {
                return;
            }

            const tag = this._firstMessageReceived ? this._recvBuf[1] : this._recvBuf[0];

            let idx = prefixLen;
            let shift = 0;
            let size = 0;
            let sizeDone = false;
            while (idx < this._recvBuf.length) {
                const b = this._recvBuf[idx];
                idx++;
                size |= (b & 0x7f) << shift;
                if ((b & 0x80) === 0) {
                    sizeDone = true;
                    break;
                }
                shift += 7;
            }
            if (!sizeDone) {
                return;
            } // need more bytes for the varint itself

            if (this._recvBuf.length < idx + size) {
                return;
            } // need more bytes for the payload

            const payload = this._recvBuf.subarray(idx, idx + size);
            this._recvBuf = this._recvBuf.subarray(idx + size);
            this._firstMessageReceived = false;

            this._handleFrame(tag, payload);
        }
    }

    /**
     * Decodes one received frame and reacts to it (login result, heartbeat, push data, ...).
     *
     * @param {number} tag the MCS message tag
     * @param {Buffer} payload the protobuf-encoded message body
     */
    _handleFrame(tag, payload) {
        this._lastMessageTime = Date.now();
        const typeName = TAG_TO_TYPE[tag];
        if (!typeName) {
            this.log.debug(`MCS: unknown tag ${tag} received, ignoring.`);
            return;
        }

        const Type = this._root.lookupType(`mcs_proto.${typeName}`);
        const decoded = Type.decode(payload);
        const obj = Type.toObject(decoded, { defaults: true, longs: String });

        switch (typeName) {
            case 'LoginResponse':
                if (obj.error && obj.error.code) {
                    this.log.warn(`MCS login failed: ${obj.error.message || obj.error.code}`);
                    return;
                }
                this._loggedIn = true;
                this.log.debug('MCS: logged in successfully.');
                this._startHeartbeat();
                break;
            case 'HeartbeatPing':
                this._send('HeartbeatAck', {});
                break;
            case 'HeartbeatAck':
                break;
            case 'Close':
                this.log.debug('MCS: server closed the connection.');
                this._socket.destroy();
                break;
            case 'DataMessageStanza':
                this._handleDataMessage(obj).catch(err =>
                    this.log.debug(`MCS: could not process push message: ${err.message}`),
                );
                break;
            default:
                break;
        }
    }

    /** Starts the periodic check that pings the server when the line has been quiet for too long. */
    _startHeartbeat() {
        if (this._heartbeatTimer) {
            this._timers.clearInterval(this._heartbeatTimer);
        }
        this._heartbeatTimer = this._timers.setInterval(() => {
            if (Date.now() - this._lastMessageTime > HEARTBEAT_INTERVAL_MS && this._loggedIn) {
                try {
                    this._send('HeartbeatPing', {});
                } catch (err) {
                    this.log.debug(`MCS: could not send heartbeat: ${err.message}`);
                }
            }
        }, HEARTBEAT_CHECK_MS);
    }

    /**
     * Decrypts one pushed data message and, if it answers a pending locate
     * request, resolves that request with the decoded DeviceUpdate.
     *
     * @param {object} msg the decoded DataMessageStanza
     */
    async _handleDataMessage(msg) {
        const appData = msg.appData || [];
        const byKey = key => {
            const entry = appData.find(x => x.key === key);
            return entry ? entry.value : null;
        };

        if (msg.persistentId) {
            this._sendSelectiveAck(msg.persistentId);
        }

        const cryptoKeyRaw = byKey('crypto-key');
        const encryptionRaw = byKey('encryption');
        if (!cryptoKeyRaw || !encryptionRaw || !msg.rawData) {
            return; // e.g. a "deleted_messages" control message, nothing to decrypt
        }

        const dh = b64urlToBuffer(cryptoKeyRaw.slice(3)); // strip "dh="
        const salt = b64urlToBuffer(encryptionRaw.slice(5)); // strip "salt="
        const rawData = Buffer.isBuffer(msg.rawData) ? msg.rawData : Buffer.from(msg.rawData, 'base64');

        const { ecdhPrivateKey, ecdhPublicKey, authSecret } = this._identity;
        const decrypted = decryptAesGcmWebPush(rawData, salt, dh, authSecret, ecdhPrivateKey, ecdhPublicKey);

        let payload;
        try {
            payload = JSON.parse(decrypted.toString('utf8'));
        } catch {
            this.log.debug('MCS: push payload was not JSON, ignoring.');
            return;
        }

        const fmdPayloadB64 = payload.data && payload.data['com.google.android.apps.adm.FCM_PAYLOAD'];
        if (!fmdPayloadB64) {
            return;
        }

        const deviceUpdateBuf = Buffer.from(fmdPayloadB64, 'base64');
        const DeviceUpdateType = this._deviceUpdateRoot.lookupType('googlefindmydevice.DeviceUpdate');
        const decoded = DeviceUpdateType.decode(deviceUpdateBuf);
        const deviceUpdate = DeviceUpdateType.toObject(decoded, { defaults: true, longs: String });

        const requestUuid = deviceUpdate.fcmMetadata && deviceUpdate.fcmMetadata.requestUuid;
        if (!requestUuid || !this._pending.has(requestUuid)) {
            return;
        }

        const { resolve, timeout } = this._pending.get(requestUuid);
        this._timers.clearTimeout(timeout);
        this._pending.delete(requestUuid);
        resolve(deviceUpdate);
    }

    /**
     * Acknowledges a received message so the server doesn't redeliver it.
     *
     * @param {string} persistentId the message's persistent id
     */
    _sendSelectiveAck(persistentId) {
        try {
            const SelectiveAck = this._root.lookupType('mcs_proto.SelectiveAck');
            const ackMsg = SelectiveAck.create({ id: [persistentId] });
            this._send('IqStanza', {
                type: 1, // SET
                id: '',
                extension: { id: MCS_SELECTIVE_ACK_ID, data: SelectiveAck.encode(ackMsg).finish() },
            });
        } catch (err) {
            this.log.debug(`MCS: could not send selective ack: ${err.message}`);
        }
    }
}

module.exports = { McsClient };
