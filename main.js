'use strict';

const crypto = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { gcmCheckin } = require('./lib/google-checkin');
const { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG } = require('./lib/google-auth');
const { listDevices, executeLocateAction, executeSoundAction } = require('./lib/nova-api');
const {
    extractSharedKeyFromVaultKeys,
    retrieveOwnerKey,
    buildEncryptionUnlockUrl,
    CONSOLE_SNIPPET,
} = require('./lib/owner-key');
const { decryptLatestLocation } = require('./lib/decrypt-locations');
const { registerFcm } = require('./lib/fcm-register');
const { McsClient } = require('./lib/mcs-client');
const { describeStructure } = require('./lib/proto-fields');
const {
    ENCRYPTED_NATIVE_FIELDS,
    looksCorrupted,
    clampMinutes,
    canonicIdToStateId,
    describeDevice,
    newestLocation,
    isOlderThanStored,
    findSemanticMapping,
    describeAnswer,
    isHomeName,
    systemCoordinates,
    describeIdentifierKind,
} = require('./lib/util');
const {
    buildDeviceObjects,
    PUSH_IDS_STATE_ID,
    buildPushIdsObject,
    DIAGNOSTICS_STATE_ID,
    buildDiagnosticsObject,
} = require('./lib/objects');
const { Diagnostics } = require('./lib/diagnostics');

const ADM_SERVICE_SCOPE = 'oauth2:https://www.googleapis.com/auth/android_device_manager';
const ADM_APP = 'com.google.android.apps.adm';
const SPOT_SERVICE_SCOPE = 'oauth2:https://www.googleapis.com/auth/spot';
const SPOT_APP = 'com.google.android.gms';

// A number of minutes small enough that minutes * 60 * 1000 never overflows
// setTimeout's 32-bit signed millisecond limit.
const POLL_MIN_MINUTES = 1;
const POLL_MAX_MINUTES = 1440; // 24h

// "Locate now" pings the tracker over BLE via nearby phones and costs it
// battery, unlike the plain name/metadata poll above - so it gets its own,
// much more conservative, per-device interval (see admin/jsonConfig.json's
// device table).
const LOCATE_MIN_MINUTES = 5;
const LOCATE_MAX_MINUTES = 1440; // 24h
const LOCATE_INITIAL_DELAY_MS = 20000; // give the MCS connection time to log in first
const LOCATE_RESPONSE_TIMEOUT_MS = 45000;
const LOCATE_EXTRA_ANSWERS_MS = 3000; // Google may send further answers after the first one (never seen so far)
const SOUND_KEY_MAX_AGE_MS = 30 * 60 * 1000; // a stop for a ring older than this probably no longer fits
const SOUND_KEYS_KEPT = 5; // started sounds remembered per tracker
const SOUND_STOP_MIN_DELAY_MS = 12000; // a stop right after a start can silence the tracker, so it waits this long
const LOCATE_RETRY_DELAY_MS = 10000; // pause before a location request without an answer is repeated once

class Googlefindmydevice extends utils.Adapter {
    /**
     * Creates the adapter instance.
     *
     * @param {Partial<utils.AdapterOptions>} [options] adapter options passed in by js-controller
     */
    constructor(options) {
        super({
            ...options,
            name: 'googlefindmydevice',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.unloaded = false;
        this.pollTimeout = null;
        this.locateTimers = new Map();
        this.trackers = new Map(); // state id -> {canonicId, name}, for the buttons
        this.locating = new Set(); // trackers with a location request in progress
        this.soundKeys = new Map(); // canonicId -> [{uuid, at}] of the sounds started and not stopped yet (needed to stop them)
        this.currentCanonicIds = null; // ids of the trackers in the account, once the first list has arrived
        this.staleWarned = new Set(); // ids already reported as gone from the account
        this.decryptWarned = new Set(); // trackers whose reports could not be decrypted (warned once)
        this.semanticRegistered = new Set(); // place names already checked against the "Named places" table
        this.diagnostics = new Diagnostics(); // facts for compatibility reports, see lib/diagnostics.js
        this.diagnosticsReady = false;
        this.trackingInitialised = new Set(); // trackers whose "tracking" switch was checked in this run
        this.legacyChecked = new Set(); // trackers already checked for the removed EID states in this run
        // Tracker object tree already created in this run (id -> device name).
        // Objects are written once per run, not on every poll.
        this.ensuredDevices = new Map();
        this.lastDeviceIds = null;
        // this.log isn't initialized yet at construction time - hand McsClient
        // a wrapper that reads it lazily on each call instead of a snapshot
        // taken before it exists (that snapshot would stay undefined forever).
        this.mcsClient = new McsClient({
            log: {
                debug: msg => this.log.debug(msg),
                info: msg => this.log.info(msg),
                warn: msg => this.log.warn(msg),
                error: msg => this.log.error(msg),
            },
            // adapter.setTimeout/setInterval (not the raw Node globals) so
            // these get cleaned up automatically if the adapter is stopped
            // mid-flight, same reasoning as the log wrapper above.
            timers: {
                setTimeout: (fn, ms) => this.setTimeout(fn, ms),
                clearTimeout: timer => this.clearTimeout(timer),
                setInterval: (fn, ms) => this.setInterval(fn, ms),
                clearInterval: timer => this.clearInterval(timer),
            },
        });
        this.mcsClient.onUnmatchedUpdate = update => this.onUnmatchedPush(update);
        this.fcmIdentity = null;
        this.fcmReadyPromise = null;
        this.fmdClientUuid = crypto.randomUUID();
    }

    /**
     * Starts the adapter once js-controller has initialised it: runs the
     * one-off setup steps while they are pending, otherwise starts polling.
     */
    async onReady() {
        if (await this.repairDoubleDecryptedNative()) {
            return; // updateConfig() above already triggers a restart with the corrected values
        }

        await this.migrateLegacyDevicesTree();

        if (this.config.oauthToken) {
            await this.bootstrapFromOauthToken();
            return; // updateConfig() inside it triggers a restart with the new config
        }

        if (!this.config.aasToken || !this.config.androidId || !this.config.email) {
            this.log.warn(
                'Not set up yet: please enter the oauth_token value in the instance configuration (see README).',
            );
            await this.setState('info.connection', false, true);
            return;
        }

        if (this.config.sharedKeyJson) {
            await this.bootstrapOwnerKey();
            return; // updateConfig() inside it triggers a restart with the new config
        }

        if (!this.config.ownerKey) {
            await this.logStep2Instructions();
        } else {
            this.startLocateTimers();
        }

        this.subscribeStates('*'); // the buttons below each tracker
        await this.ensureDiagnosticsObject();
        await this.pollLoop();
    }

    /**
     * Repairs instances configured before protectedNative/encryptedNative
     * moved to their correct top-level location in io-package.json.
     * js-controller auto-decrypts every field in ENCRYPTED_NATIVE_FIELDS
     * on each startup - but this adapter used to write them with plain
     * extendForeignObject() calls (now fixed to use updateConfig()
     * instead, see bootstrapFromOauthToken/bootstrapOwnerKey), so
     * already-plain values got run through decrypt() once for nothing,
     * turning them to garbage. That legacy decrypt is a simple
     * repeating-XOR and therefore its own inverse, so decrypting the
     * garbage a second time restores the original value.
     *
     * Detection is content-based (looksCorrupted()) rather than a
     * one-time-migration flag: a flag stored in native can end up
     * merged into already-existing instances by the update/install
     * process itself, which would make it look like a fresh instance
     * that never needed the fix and skip it forever. Checking the
     * actual values instead makes this self-correcting on every
     * startup, for a negligible cost (a few regex/JSON checks on short
     * strings) when there's nothing to fix.
     *
     * @returns {Promise<boolean>} true if a restart was triggered
     */
    async repairDoubleDecryptedNative() {
        const patch = {};

        for (const field of ENCRYPTED_NATIVE_FIELDS) {
            const value = this.config[field];
            if (typeof value !== 'string' || !value || !looksCorrupted(field, value)) {
                continue;
            }
            try {
                const restored = this.decrypt(value);
                if (looksCorrupted(field, restored)) {
                    throw new Error('still looks corrupted after a second decrypt pass');
                }
                patch[field] = restored;
            } catch (err) {
                this.log.warn(
                    `Could not repair stored "${field}" value (${err.message}) - please redo the affected setup step.`,
                );
            }
        }

        if (Object.keys(patch).length === 0) {
            return false;
        }

        this.log.warn(
            'Repairing configuration values that were corrupted by an earlier update (see the changelog) - the adapter will restart once more.',
        );
        await this.updateConfig(patch);
        return true;
    }

    /**
     * Removes the "devices" folder (and everything below it) that earlier
     * versions created. Trackers now live directly below the instance as
     * `device` objects, so the old tree would otherwise stay behind as a
     * stale duplicate.
     */
    async migrateLegacyDevicesTree() {
        const legacy = await this.getObjectAsync('devices');
        if (!legacy) {
            return;
        }
        this.log.info(
            'Removing the legacy "devices" folder - trackers now live directly below the instance (see changelog).',
        );
        await this.delObject('devices', { recursive: true });
    }

    /**
     * Logs the instructions for the second setup step (unlocking the
     * end-to-end encryption key) as individual, copy-friendly log lines.
     */
    async logStep2Instructions() {
        try {
            const url = await buildEncryptionUnlockUrl();
            // One log line per piece, with the link/snippet completely alone
            // on their own line - a single combined line makes it hard to
            // tell where the URL/code actually ends and the next sentence
            // begins, which makes copying the right part error-prone.
            //
            // ioBroker's log viewer shows the newest entry first, so these
            // are emitted in REVERSE order - the last call here ends up on
            // top, making the visible list read top-to-bottom correctly.
            this.log.warn(
                '3) Do whatever Google asks for on that page. 4) Copy the text field that then appears at the top ' +
                    'of the page completely and paste it into the instance configuration under "Result from the ' +
                    'browser console", then save.',
            );
            this.log.warn(CONSOLE_SNIPPET);
            this.log.warn(
                '2) Open developer tools (F12) -> "Console" tab -> paste the following code completely and press Enter (only the code, nothing before/after):',
            );
            this.log.warn(url);
            this.log.warn('1) Open this link in your browser (only the URL, nothing before/after):');
            this.log.warn(
                'Location decryption not set up yet (setup Part 2). Device names are still being updated in the meantime.',
            );
        } catch (err) {
            this.log.error(`Could not generate the Part 2 instructions: ${err.message}`);
        }
    }

    /**
     * Setup step 2, the pure part: turns the pasted browser-console result
     * into the decrypted owner key. Needs only the values passed in, so it
     * works for the configuration page's button before anything is saved.
     *
     * @param {object} account the connected account
     * @param {string} account.email account email
     * @param {string} account.aasToken the long-lived account token
     * @param {string} account.androidId the GCM android id
     * @param {string} sharedKeyJson the pasted browser-console result
     * @returns {Promise<{ownerKey: string, ownerKeyVersion: number}>} the owner key (hex) and its version
     */
    async deriveOwnerKey({ email, aasToken, androidId }, sharedKeyJson) {
        const sharedKey = extractSharedKeyFromVaultKeys(sharedKeyJson);
        const { Auth: spotToken } = await performOAuth(
            email,
            aasToken,
            androidId,
            SPOT_SERVICE_SCOPE,
            SPOT_APP,
            DEFAULT_CLIENT_SIG,
        );
        const { ownerKey, ownerKeyVersion } = await retrieveOwnerKey(spotToken, sharedKey);
        return { ownerKey: ownerKey.toString('hex'), ownerKeyVersion };
    }

    /**
     * Setup step 1, the pure part: exchanges the pasted oauth_token for a
     * long-lived account token.
     *
     * @param {string} oauthToken the pasted oauth_token cookie value
     * @returns {Promise<{email: string, androidId: string, securityToken: string, aasToken: string}>} the account data to store
     */
    async exchangeLoginToken(oauthToken) {
        const { androidId, securityToken } = await gcmCheckin();
        let exchangeResult;
        try {
            exchangeResult = await exchangeToken('', oauthToken, androidId);
        } catch (err) {
            if (/BadAuthentication/.test(err.message)) {
                throw new Error(
                    'Google rejected the oauth_token - it has probably expired or was copied incompletely. ' +
                        'Please paste a fresh value (see README).',
                );
            }
            throw err;
        }

        if (!exchangeResult.Token || !exchangeResult.Email) {
            throw new Error(
                'Google did not return a valid token - the oauth_token value has probably expired. ' +
                    'Please enter a fresh value (see README).',
            );
        }
        return { email: exchangeResult.Email, androidId, securityToken, aasToken: exchangeResult.Token };
    }

    /**
     * Fallback for a configuration that was saved with a still unused
     * step 2 result (the page's button normally handles this directly).
     */
    async bootstrapOwnerKey() {
        try {
            this.log.info('Part 2 result detected, fetching and decrypting the owner key...');
            const { ownerKey, ownerKeyVersion } = await this.deriveOwnerKey(this.config, this.config.sharedKeyJson);

            // updateConfig() (not extendForeignObject) so these
            // encryptedNative fields actually get encrypted at rest -
            // js-controller decrypts them again on the next startup.
            await this.updateConfig({ sharedKeyJson: '', ownerKey, ownerKeyVersion });

            this.log.info('Owner key set up successfully. Adapter is restarting...');
        } catch (err) {
            this.log.error(`Part 2 setup failed: ${err.message}`);
            await this.setState('info.connection', false, true);
            // Clear it so a bad/expired value doesn't get retried forever on
            // every restart, and so the field is guaranteed empty for a
            // fresh attempt instead of silently keeping the failed one.
            await this.updateConfig({ sharedKeyJson: '' });
        }
    }

    /**
     * Fallback for a configuration that was saved with a still unused
     * oauth_token (the page's button normally handles this directly).
     */
    async bootstrapFromOauthToken() {
        try {
            this.log.info('Login token detected, exchanging it for a long-lived account token...');
            const account = await this.exchangeLoginToken(this.config.oauthToken);

            // updateConfig() (not extendForeignObject) so these
            // encryptedNative fields actually get encrypted at rest -
            // js-controller decrypts them again on the next startup.
            await this.updateConfig({ oauthToken: '', ...account });

            this.log.info('Successfully connected to the Google account. Adapter is restarting...');
        } catch (err) {
            this.log.error(`Setup failed: ${err.message}`);
            await this.setState('info.connection', false, true);
            // Clear it so an expired/invalid oauth_token doesn't get retried
            // forever on every restart, and so the field is guaranteed empty
            // for a fresh paste instead of silently keeping the failed one.
            await this.updateConfig({ oauthToken: '' });
        }
    }

    /**
     * One poll cycle: refreshes all trackers, then schedules the next cycle
     * (self-chaining timeout, so a slow cycle can never overlap the next).
     */
    async pollLoop() {
        if (this.unloaded) {
            return;
        }

        try {
            await this.updateDevices();
            await this.setStateChanged('info.connection', { val: true, ack: true });
        } catch (err) {
            this.log.error(`Update failed: ${err.message}`);
            await this.setStateChanged('info.connection', { val: false, ack: true });
        }

        if (this.unloaded) {
            return; // stopped while the update was running - don't start a new timer
        }

        const minutes = clampMinutes(this.config.pollInterval, POLL_MIN_MINUTES, POLL_MAX_MINUTES, 15);
        this.pollTimeout = this.setTimeout(() => this.pollLoop(), minutes * 60 * 1000);
    }

    /**
     * Lists the account's trackers and writes their object trees, metadata
     * and (if the owner key is set up) their latest decrypted location.
     */
    async updateDevices() {
        const { Auth: admToken } = await performOAuth(
            this.config.email,
            this.config.aasToken,
            this.config.androidId,
            ADM_SERVICE_SCOPE,
            ADM_APP,
            DEFAULT_CLIENT_SIG,
        );

        const allDevices = await listDevices(admToken);

        // Nova's SPOT_DEVICE listing also includes phones/tablets/other
        // Fast Pair devices linked to the account, but never any usable data
        // for them (information stays null - confirmed live). Only real
        // Bluetooth/FMDN trackers get a canonicId out of listDevices(), so
        // filtering on that also filters out everything that would otherwise
        // show up as an empty, useless object branch in ioBroker.
        const devices = allDevices.filter(d => d.canonicId);
        this.currentCanonicIds = new Set(devices.map(d => d.canonicId));
        this.log.debug(`${devices.length} tracker(s) found (out of ${allDevices.length} devices in the account).`);
        for (const tracker of devices) {
            this.log.debug(`Tracker: ${describeDevice(tracker)}`);
        }
        for (const skipped of allDevices.filter(d => !d.canonicId)) {
            this.log.debug(`Skipped a device without tracker identifier: ${describeDevice(skipped)}`);
        }

        await this.syncDeviceSettings(devices);
        await this.cleanupStaleDevices(devices);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;

        this.trackers.clear();
        for (const device of devices) {
            const stateId = canonicIdToStateId(device.canonicId);
            this.trackers.set(stateId, {
                canonicId: device.canonicId,
                name: device.name,
                capabilities: device.capabilities,
            });
            await this.ensureDevice(stateId, device.name);
            await this.initTrackingState(stateId);
            this.diagnostics.setDevice(device.canonicId, {
                manufacturer: device.manufacturer,
                model: device.model,
                deviceType: device.deviceType,
                fastPairModelId: device.fastPairModelId,
                identifierKind: describeIdentifierKind(device.identifierLayout),
                capabilities: device.capabilities,
            });
            await this.updateDeviceMetadataStates(stateId, device);
            await this.removeLegacyEidStates(stateId);

            if (!ownerKey) {
                continue;
            }

            try {
                const location = await decryptLatestLocation(ownerKey, device, {
                    onSkip: this.skippedReportLogger(device.name, device.canonicId),
                });
                if (location) {
                    this.diagnostics.recordAnswer(device.canonicId, location);
                }
                if (!location) {
                    this.log.debug(
                        `No location report for "${device.name}" yet (none fetched so far, or cache empty).`,
                    );
                } else {
                    this.log.debug(`Decrypted location for "${device.name}": ${JSON.stringify(location)}`);
                }
                await this.updateLocationStates(stateId, location);
                if (!location) {
                    await this.reapplySemanticMapping(stateId);
                }
            } catch (err) {
                this.warnDecryptOnce(device.name, err);
            }
        }
    }

    /**
     * Builds the callback that logs (at debug level) every location report
     * that had to be left out, with the reason but never the content.
     *
     * @param {string} name the tracker's display name
     * @param {string} canonicId Google's id of the tracker (for the diagnostic report)
     * @returns {(info: {reason: string, keyPartLength?: number}) => void} the callback for decryptLatestLocation()
     */
    skippedReportLogger(name, canonicId) {
        return info => {
            this.diagnostics.recordSkip(canonicId, info);
            const size = info.keyPartLength === undefined ? '' : ` (key part: ${info.keyPartLength} bytes)`;
            this.log.debug(`Skipped a location report for "${name}": ${info.reason}${size}.`);
        };
    }

    /**
     * Warns that none of a tracker's reports could be decrypted - once per
     * tracker and run, so a permanent problem does not fill the log at every poll.
     *
     * @param {string} name the tracker's display name
     * @param {Error} err the decryption error
     */
    warnDecryptOnce(name, err) {
        if (this.decryptWarned.has(name)) {
            this.log.debug(`Could not decrypt the location of "${name}": ${err.message}`);
            return;
        }
        this.decryptWarned.add(name);
        this.log.warn(
            `Could not decrypt the location of "${name}": ${err.message}. This is logged once per start; set the log level to debug for details.`,
        );
    }

    /**
     * Version 0.1.4 could publish BLE identifier (EID) states below a tracker.
     * That option was removed again (the values did not match what the tracker
     * broadcasts), so remove what an earlier run may have left behind.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     */
    async removeLegacyEidStates(stateId) {
        if (this.legacyChecked.has(stateId)) {
            return;
        }
        this.legacyChecked.add(stateId);
        if (await this.getObjectAsync(`${stateId}.eid`)) {
            await this.delObject(`${stateId}.eid`, { recursive: true });
        }
    }

    /**
     * Writes the static per-tracker information (manufacturer, model, ...).
     * Uses setStateChanged so unchanged values don't cause database writes.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     * @param {object} device the tracker as returned by listDevices()
     */
    async updateDeviceMetadataStates(stateId, device) {
        await this.setStateChanged(`${stateId}.manufacturer`, { val: device.manufacturer || '', ack: true });
        await this.setStateChanged(`${stateId}.model`, { val: device.model || '', ack: true });
        await this.setStateChanged(`${stateId}.fastPairModelId`, { val: device.fastPairModelId || '', ack: true });
        await this.setStateChanged(`${stateId}.deviceType`, { val: device.deviceType || '', ack: true });
        await this.setStateChanged(`${stateId}.pairDate`, {
            val: device.pairDate ? device.pairDate * 1000 : null,
            ack: true,
        });
        await this.setStateChanged(`${stateId}.sharedWithCount`, { val: device.sharedWithCount || 0, ack: true });
    }

    /**
     * Adds newly discovered trackers to native.deviceSettings (used by the
     * admin UI's per-device table, see admin/jsonConfig.json) with "locate"
     * disabled by default - fetching a fresh location pings the tracker over
     * BLE and costs it battery, so that has to be an opt-in per device
     * rather than something this adapter turns on automatically.
     *
     * @param {Array<{canonicId: string, name: string}>} devices the account's current trackers
     */
    async syncDeviceSettings(devices) {
        const existing = Array.isArray(this.config.deviceSettings) ? this.config.deviceSettings : [];
        const existingIds = new Set(existing.map(d => d.canonicId));

        const missing = devices
            .filter(d => d.canonicId && !existingIds.has(d.canonicId))
            .map(d => ({
                canonicId: d.canonicId,
                name: d.name,
                locate: false,
                intervalMinutes: 60,
            }));

        if (missing.length === 0) {
            return;
        }

        this.log.info(`${missing.length} new tracker(s) found, added to the device table in the configuration.`);
        await this.extendForeignObject(`system.adapter.${this.namespace}`, {
            native: { deviceSettings: existing.concat(missing) },
        });
    }

    /**
     * Removes any tracker `device` object that isn't a current tracker any
     * more (e.g. removed from the Google account) - ioBroker doesn't drop
     * objects on its own just because a poll stops touching them. Only runs
     * when the set of trackers changed since the last poll, and never for an
     * empty list (that is far more likely a hiccup than "all trackers gone").
     *
     * @param {Array<{canonicId: string}>} devices the account's current trackers
     */
    async cleanupStaleDevices(devices) {
        if (devices.length === 0) {
            return;
        }

        const currentIds = new Set(devices.map(d => canonicIdToStateId(d.canonicId)));
        const idsKey = [...currentIds].sort().join(',');
        if (idsKey === this.lastDeviceIds) {
            return;
        }
        this.lastDeviceIds = idsKey;

        const allObjects = await this.getAdapterObjectsAsync();
        const prefix = `${this.namespace}.`;

        for (const id of Object.keys(allObjects)) {
            if (!id.startsWith(prefix) || allObjects[id].type !== 'device') {
                continue;
            }
            const deviceId = id.slice(prefix.length);
            if (!currentIds.has(deviceId)) {
                this.log.info(`Removing "${deviceId}" from the object tree (no longer a tracker of this account).`);
                await this.delObject(id, { recursive: true });
                this.ensuredDevices.delete(deviceId);
            }
        }
    }

    /**
     * Registers with FCM and opens the persistent MCS push connection, once
     * per adapter run, so triggerLocate() can wait for the asynchronous
     * answer to a "locate now" request.
     *
     * @returns {Promise<void>} resolves once the push connection is being established
     */
    async ensureFcmReady() {
        if (this.fcmReadyPromise) {
            return this.fcmReadyPromise;
        }

        this.fcmReadyPromise = (async () => {
            this.log.debug('Registering with Firebase Cloud Messaging for location push notifications...');
            this.fcmIdentity = await registerFcm({
                androidId: this.config.androidId,
                securityToken: this.config.securityToken,
            });
            await this.restoreReceivedPushIds();
            await this.mcsClient.start({
                androidId: this.config.androidId,
                securityToken: this.config.securityToken,
                ...this.fcmIdentity,
            });
        })();

        return this.fcmReadyPromise;
    }

    /**
     * Loads the ids of the push messages received in earlier runs and keeps
     * them up to date, so the login can tell Google which messages not to
     * deliver again.
     */
    async restoreReceivedPushIds() {
        let ids = [];
        try {
            await this.extendObject(PUSH_IDS_STATE_ID, buildPushIdsObject());
            const state = await this.getStateAsync(PUSH_IDS_STATE_ID);
            ids = state && typeof state.val === 'string' ? JSON.parse(state.val) : [];
        } catch (err) {
            this.log.debug(`Could not read the list of received push messages: ${err.message}`);
        }
        this.mcsClient.setReceivedIds(ids, list => {
            this.setState(PUSH_IDS_STATE_ID, { val: JSON.stringify(list), ack: true }).catch(err =>
                this.log.debug(`Could not save the list of received push messages: ${err.message}`),
            );
        });
        this.log.debug(`${Array.isArray(ids) ? ids.length : 0} received push message id(s) restored.`);
    }

    /**
     * Sets up one self-rescheduling timer per tracker with "locate" enabled
     * in native.deviceSettings, each running on its own configured interval
     * (see LOCATE_MIN_MINUTES/LOCATE_MAX_MINUTES).
     */
    startLocateTimers() {
        const settings = Array.isArray(this.config.deviceSettings) ? this.config.deviceSettings : [];

        for (const setting of settings) {
            if (!setting.locate || !setting.canonicId) {
                continue;
            }

            const minutes = clampMinutes(setting.intervalMinutes, LOCATE_MIN_MINUTES, LOCATE_MAX_MINUTES, 60);

            const scheduleNext = delayMs => {
                if (this.unloaded) {
                    return; // never start a new timer once the adapter is stopping
                }
                const timer = this.setTimeout(async () => {
                    try {
                        if (await this.isTrackingPaused(canonicIdToStateId(setting.canonicId))) {
                            this.log.debug(`Automatic requests for "${setting.name}" are switched off.`);
                        } else {
                            await this.triggerLocate(setting.canonicId, setting.name);
                        }
                    } catch (err) {
                        this.log.warn(`Location request for "${setting.name}" failed: ${err.message}`);
                    }
                    scheduleNext(minutes * 60 * 1000);
                }, delayMs);
                this.locateTimers.set(setting.canonicId, timer);
            };

            scheduleNext(LOCATE_INITIAL_DELAY_MS);
        }
    }

    /**
     * Creates the state that holds the diagnostic report, once.
     */
    async ensureDiagnosticsObject() {
        try {
            await this.extendObject(DIAGNOSTICS_STATE_ID, buildDiagnosticsObject());
            this.diagnosticsReady = true;
        } catch (err) {
            this.log.debug(`Could not create the diagnostic report: ${err.message}`);
        }
    }

    /**
     * Writes the diagnostic report (model data and counts, no names, ids or positions).
     */
    async writeDiagnostics() {
        if (!this.diagnosticsReady) {
            return;
        }
        try {
            await this.setStateChanged(DIAGNOSTICS_STATE_ID, {
                val: this.diagnostics.reportJson(this.version || ''),
                ack: true,
            });
        } catch (err) {
            this.log.debug(`Could not write the diagnostic report: ${err.message}`);
        }
    }

    /**
     * Whether the "tracking" switch of a tracker is off, which pauses its
     * automatic location requests (the buttons still work).
     *
     * @param {string} stateId sanitized id of the tracker's device object
     * @returns {Promise<boolean>} true if the switch is off
     */
    async isTrackingPaused(stateId) {
        const state = await this.getStateAsync(`${stateId}.tracking`);
        return !!state && state.val === false;
    }

    /**
     * Gives the "tracking" switch of a tracker its initial value (on) once.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     */
    async initTrackingState(stateId) {
        if (this.trackingInitialised.has(stateId)) {
            return;
        }
        this.trackingInitialised.add(stateId);
        const state = await this.getStateAsync(`${stateId}.tracking`);
        if (!state) {
            await this.setState(`${stateId}.tracking`, { val: true, ack: true });
        }
    }

    /**
     * Reacts to a change of one of the switches and buttons below a tracker:
     * tracking on/off, locate now, play sound, stop sound. Only a change from
     * outside (ack=false) counts; it is acknowledged when the action is done.
     * (Locate and the sounds react to a press, a value of true.)
     *
     * @param {string} id the full id of the changed state
     * @param {ioBroker.State | null | undefined} state the new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const match = /\.([^.]+)\.(locateNow|playSound|stopSound|tracking)$/.exec(id);
        if (!match) {
            return;
        }
        const [, stateId, action] = match;
        if (action === 'tracking') {
            const enabled = !!state.val;
            await this.setState(id, { val: enabled, ack: true });
            const known = this.trackers.get(stateId);
            this.log.info(
                `Automatic location requests for "${known ? known.name : stateId}" are switched ${enabled ? 'on' : 'off'}.`,
            );
            return;
        }
        if (!state.val) {
            return;
        }
        const tracker = this.trackers.get(stateId);
        if (!tracker) {
            this.log.warn(`The button ${action} was pressed, but the tracker is not in the Google account any more.`);
            return;
        }

        // Google lists which actions it offers for a device; headphones and
        // speakers, for example, have no sound. Without a list (unknown) it is tried.
        const needed = action === 'playSound' ? 31 : action === 'stopSound' ? 32 : null;
        if (
            needed &&
            tracker.capabilities &&
            tracker.capabilities.length > 0 &&
            !tracker.capabilities.includes(needed)
        ) {
            this.log.warn(
                `Google offers no sound for "${tracker.name}" (typical for headphones and speakers), so nothing was sent.`,
            );
            await this.setState(id, { val: state.val, ack: true });
            return;
        }

        try {
            if (action === 'locateNow') {
                this.log.info(`Locating "${tracker.name}" now.`);
                await this.triggerLocate(tracker.canonicId, tracker.name);
            } else {
                await this.triggerSound(tracker.canonicId, tracker.name, action === 'playSound');
            }
        } catch (err) {
            this.log.warn(`The action ${action} for "${tracker.name}" failed: ${err.message}`);
        } finally {
            await this.setState(id, { val: state.val, ack: true });
        }
    }

    /**
     * Makes a tracker play its sound or stops it. The stop is matched to the
     * start by the request id of that start, which is kept in memory.
     *
     * @param {string} canonicId Google's canonic id of the tracker
     * @param {string} name the tracker's display name (for log messages)
     * @param {boolean} start true to start the sound, false to stop it
     */
    async triggerSound(canonicId, name, start) {
        if (this.currentCanonicIds && !this.currentCanonicIds.has(canonicId)) {
            throw new Error('the tracker is no longer in the Google account');
        }
        await this.ensureFcmReady();

        const { Auth: admToken } = await performOAuth(
            this.config.email,
            this.config.aasToken,
            this.config.androidId,
            ADM_SERVICE_SCOPE,
            ADM_APP,
            DEFAULT_CLIENT_SIG,
        );

        const send = async requestUuid => {
            try {
                const reply = await executeSoundAction(
                    admToken,
                    {
                        canonicId,
                        fcmRegistrationId: this.fcmIdentity.fcmToken,
                        requestUuid,
                        fmdClientUuid: this.fmdClientUuid,
                    },
                    start,
                );
                this.diagnostics.recordSound(canonicId, start ? 'start' : 'stop');
                this.log.debug(
                    `Nova answer to the ${start ? 'start' : 'stop'} sound request: ${describeStructure(reply || Buffer.alloc(0))}`,
                );
            } catch (err) {
                const rejected = /HTTP 500/.test(err.message);
                this.diagnostics.recordSound(canonicId, rejected ? 'rejected' : 'error');
                if (rejected) {
                    throw new Error(
                        'Google rejected the request (HTTP 500); the device probably cannot play a sound this way (typical for headphones and speakers)',
                    );
                }
                throw err;
            }
        };

        if (start) {
            const requestUuid = crypto.randomUUID();
            await send(requestUuid);
            const recent = (this.soundKeys.get(canonicId) || []).filter(k => Date.now() - k.at <= SOUND_KEY_MAX_AGE_MS);
            this.soundKeys.set(canonicId, recent.concat({ uuid: requestUuid, at: Date.now() }).slice(-SOUND_KEYS_KEPT));
            this.log.info(`Sound started for "${name}".`);
            return;
        }

        // Google matches a stop to the start it belongs to by the request id, so
        // every start that was not stopped yet gets its own stop.
        const keys = this.soundKeys.get(canonicId) || [];
        if (keys.length === 0) {
            this.log.info(
                `No sound started by this adapter is known for "${name}"; the stop is sent anyway, but the tracker may keep ringing until it stops by itself.`,
            );
            await send('');
        } else {
            for (const key of keys) {
                // A stop that comes right after the start can silence the tracker
                // (measured by the Home Assistant integration), so it waits.
                const wait = key.at + SOUND_STOP_MIN_DELAY_MS - Date.now();
                if (wait > 0 && !this.unloaded) {
                    this.log.info(`The stop for "${name}" waits ${Math.ceil(wait / 1000)} s after the start.`);
                    await new Promise(resolve => this.setTimeout(resolve, wait));
                }
                if (Date.now() - key.at > SOUND_KEY_MAX_AGE_MS) {
                    this.log.debug(`A sound of "${name}" was started a long time ago; its stop may no longer fit.`);
                }
                await send(key.uuid);
            }
            // The keys stay: a second stop for the same sound must carry them again.
        }
        this.log.info(`Stop sound sent for "${name}".`);
    }

    /**
     * Actively asks Google to ping one tracker for a fresh location. Only one
     * request per tracker runs at a time; a second one (for example a button
     * press during the scheduled request) is skipped.
     *
     * @param {string} canonicId Google's canonic id of the tracker
     * @param {string} name the tracker's display name (for log messages)
     */
    async triggerLocate(canonicId, name) {
        if (this.locating.has(canonicId)) {
            this.log.debug(`A location request for "${name}" is already running.`);
            return;
        }
        this.locating.add(canonicId);
        try {
            try {
                await this.requestLocation(canonicId, name);
            } catch (err) {
                // Google sometimes does not answer the first request after the
                // push connection was (re)opened, typically right after a start.
                if (err.code !== 'LOCATE_TIMEOUT' || this.unloaded) {
                    throw err;
                }
                this.diagnostics.recordLocate(canonicId, 'retried');
                this.log.debug(`No answer for "${name}", the request is repeated once.`);
                await new Promise(resolve => this.setTimeout(resolve, LOCATE_RETRY_DELAY_MS));
                if (this.unloaded) {
                    return;
                }
                await this.requestLocation(canonicId, name);
            }
            this.diagnostics.recordLocate(canonicId, 'ok');
        } catch (err) {
            this.diagnostics.recordLocate(canonicId, err.code === 'LOCATE_TIMEOUT' ? 'timeout' : 'error');
            throw err;
        } finally {
            this.locating.delete(canonicId);
            await this.writeDiagnostics();
        }
    }

    /**
     * Asks Google to ping one tracker for a fresh location, then
     * waits for the asynchronous FCM push answer and decrypts it.
     *
     * @param {string} canonicId Google's canonic id of the tracker
     * @param {string} name the tracker's display name (for log messages)
     */
    async requestLocation(canonicId, name) {
        // A device that was paired again gets a new id; asking Google for the
        // old one only ends in an HTTP 500 every time.
        if (this.currentCanonicIds && !this.currentCanonicIds.has(canonicId)) {
            if (!this.staleWarned.has(canonicId)) {
                this.staleWarned.add(canonicId);
                this.log.warn(
                    `"${name}" is no longer in the Google account (paired again under a new id, or removed). Its location is not requested any more; remove its row from the device table.`,
                );
            }
            return;
        }
        await this.ensureFcmReady();

        const { Auth: admToken } = await performOAuth(
            this.config.email,
            this.config.aasToken,
            this.config.androidId,
            ADM_SERVICE_SCOPE,
            ADM_APP,
            DEFAULT_CLIENT_SIG,
        );

        const requestUuid = crypto.randomUUID();
        const responsePromise = this.mcsClient.waitForDeviceUpdates(
            requestUuid,
            LOCATE_RESPONSE_TIMEOUT_MS,
            LOCATE_EXTRA_ANSWERS_MS,
        );
        // Mark it as handled right away so Node doesn't log an "unhandled
        // promise rejection" if this settles (e.g. the connection drops)
        // before execution below reaches the real `await responsePromise`.
        responsePromise.catch(() => {});

        this.log.debug(`Requesting current location for "${name}"...`);
        const reply = await executeLocateAction(admToken, {
            canonicId,
            fcmRegistrationId: this.fcmIdentity.fcmToken,
            requestUuid,
            fmdClientUuid: this.fmdClientUuid,
        });
        this.log.debug(`Nova answer to the locate request: ${describeStructure(reply || Buffer.alloc(0))}`);

        const deviceUpdates = await responsePromise;
        this.log.debug(`${deviceUpdates.length} push response(s) for "${name}" received.`);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;
        if (!ownerKey) {
            return;
        }

        const stateId = canonicIdToStateId(canonicId);
        // The first poll normally created the objects already; make sure
        // they exist even if it failed, so the states below never end up
        // without an object.
        await this.ensureDevice(stateId, name);
        const locations = [];
        let lastError = null;
        for (const [index, deviceUpdate] of deviceUpdates.entries()) {
            if (!deviceUpdate.deviceMetadata) {
                continue;
            }
            try {
                const decrypted = await decryptLatestLocation(
                    ownerKey,
                    { raw: deviceUpdate.deviceMetadata },
                    { onSkip: this.skippedReportLogger(name, canonicId) },
                );
                this.log.debug(
                    `Answer ${index + 1} for "${name}": ${decrypted ? describeAnswer(decrypted) : 'no report'}.`,
                );
                locations.push(decrypted);
            } catch (err) {
                lastError = err;
                this.log.debug(`Answer ${index + 1} for "${name}" could not be decrypted: ${err.message}`);
            }
        }
        const location = newestLocation(locations);
        this.diagnostics.recordAnswer(canonicId, location);
        if (!location && lastError) {
            this.warnDecryptOnce(name, lastError);
        }
        const written = await this.updateLocationStates(stateId, location);
        if (!location) {
            this.log.debug(`Google has no location report for "${name}" at the moment.`);
        } else {
            this.log.debug(
                written
                    ? `Location for "${name}" updated.`
                    : `No newer location report for "${name}" than the stored one.`,
            );
        }
    }

    /**
     * Writes a decrypted location report into the tracker's states.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     * @param {object | null} location the decrypted report, or null if there is none yet
     * @returns {Promise<boolean>} true if the report was written, false if there was none or a newer one is stored
     */
    async updateLocationStates(stateId, location) {
        if (!location) {
            return false;
        }

        // Google answers with a different subset of reports from one request to
        // the next (and the periodic list only carries its cache), so an older
        // report must not overwrite a newer one that is already stored.
        const stored = await this.getStateAsync(`${stateId}.lastSeen`);
        if (isOlderThanStored(stored && stored.val, location)) {
            this.log.debug(
                `Ignoring a report from ${new Date(location.timestamp * 1000).toISOString()} for ${stateId}, a newer one is already stored.`,
            );
            return false;
        }

        // The timestamp tells you how fresh this report actually is, whether
        // it's a semantic ("Home") or a GPS report - always set it either way.
        await this.setStateChanged(`${stateId}.lastSeen`, { val: location.timestamp * 1000, ack: true });

        // The states always describe this one report: a named place ("Home")
        // clears the coordinates of an older GPS report, and a GPS report
        // clears the named place of an older one.
        if (location.semantic !== undefined) {
            const mapped = await this.writeSemanticStates(stateId, location.semantic);
            if (!mapped) {
                await this.registerSemanticName(location.semantic);
            }
            return true;
        }

        await this.setStateChanged(`${stateId}.semanticLocation`, { val: '', ack: true });

        await this.setStateChanged(`${stateId}.latitude`, { val: location.lat, ack: true });
        await this.setStateChanged(`${stateId}.longitude`, { val: location.lon, ack: true });
        await this.setStateChanged(`${stateId}.altitude`, { val: location.altitude, ack: true });
        await this.setStateChanged(`${stateId}.accuracy`, { val: location.accuracy, ack: true });
        await this.setStateChanged(`${stateId}.isOwnReport`, { val: !!location.isOwnReport, ack: true });
        await this.setStateChanged(`${stateId}.mapsLink`, {
            val: `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`,
            ack: true,
        });
        return true;
    }

    /**
     * Logs a push answer that no waiting location request belongs to. For a
     * sound request it names the tracker; only field numbers and sizes are
     * logged, never contents.
     *
     * @param {{requestUuid: string, structure: string}} update the request id of the answer and its field layout
     */
    onUnmatchedPush({ requestUuid, structure }) {
        for (const [canonicId, keys] of this.soundKeys) {
            if (keys.some(key => key.uuid === requestUuid)) {
                const tracker = [...this.trackers.values()].find(t => t.canonicId === canonicId);
                this.log.debug(
                    `Push answer to a sound request for "${tracker ? tracker.name : canonicId}": ${structure}`,
                );
                return;
            }
        }
        this.log.debug(`MCS: push message for an unknown or expired request ignored: ${structure}`);
    }

    /**
     * Writes the position states for a named place ("Home"): the coordinates
     * the user assigned to that name in the "Named places" table, or empty
     * values if there are none.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     * @param {string} name the place name reported by Google
     * @returns {Promise<{lat: number, lon: number, radius: number} | null>} the assigned coordinates, if any
     */
    async writeSemanticStates(stateId, name) {
        const mapped = findSemanticMapping(this.config.semanticLocations, name);
        await this.setStateChanged(`${stateId}.semanticLocation`, { val: name, ack: true });
        await this.setStateChanged(`${stateId}.latitude`, { val: mapped ? mapped.lat : null, ack: true });
        await this.setStateChanged(`${stateId}.longitude`, { val: mapped ? mapped.lon : null, ack: true });
        await this.setStateChanged(`${stateId}.altitude`, { val: null, ack: true });
        await this.setStateChanged(`${stateId}.accuracy`, { val: mapped ? mapped.radius : null, ack: true });
        await this.setStateChanged(`${stateId}.isOwnReport`, { val: null, ack: true });
        await this.setStateChanged(`${stateId}.mapsLink`, {
            val: mapped ? `https://www.google.com/maps/search/?api=1&query=${mapped.lat},${mapped.lon}` : '',
            ack: true,
        });
        return mapped;
    }

    /**
     * Applies the current "Named places" table to a tracker that is already
     * at a named place, without waiting for the next report. Without it a
     * change of the table would only show up with the next location answer.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     */
    async reapplySemanticMapping(stateId) {
        const state = await this.getStateAsync(`${stateId}.semanticLocation`);
        if (state && typeof state.val === 'string' && state.val) {
            await this.writeSemanticStates(stateId, state.val);
        }
    }

    /**
     * Adds a place name that Google reported to the "Named places" table of
     * the configuration (without coordinates), so the user only has to fill
     * in latitude and longitude. Checked once per name and run. The name is
     * not logged: it is whatever the user called the place in Find Hub.
     *
     * @param {string} name the place name reported by Google
     */
    async registerSemanticName(name) {
        const trimmed = String(name || '').trim();
        const key = trimmed.toLowerCase();
        if (!key || this.semanticRegistered.has(key)) {
            return;
        }
        this.semanticRegistered.add(key);

        const existing = Array.isArray(this.config.semanticLocations) ? this.config.semanticLocations : [];
        if (
            existing.some(
                row =>
                    row &&
                    String(row.name || '')
                        .trim()
                        .toLowerCase() === key,
            )
        ) {
            return;
        }
        // For the home place the position from the ioBroker system settings is the natural choice.
        const home = isHomeName(trimmed) ? systemCoordinates(await this.getForeignObjectAsync('system.config')) : null;
        this.log.info(
            home
                ? 'Google reported your home place; it was added to the table "Named places" in the configuration with the position from the ioBroker system settings. Please check it there.'
                : 'Google reported a named place without coordinates; it was added to the table "Named places" in the configuration. Enter its latitude and longitude there to get a map position.',
        );
        await this.extendForeignObject(`system.adapter.${this.namespace}`, {
            native: {
                semanticLocations: existing.concat({
                    name: trimmed,
                    latitude: home ? home.lat : null,
                    longitude: home ? home.lon : null,
                    radius: 100,
                }),
            },
        });
    }

    /**
     * Makes sure one tracker's object tree exists and is up to date.
     *
     * The full tree (the tracker as a `device` object plus all its states)
     * is written once per adapter run with extendObject, so definition
     * changes between adapter versions - names, roles, ... - still reach
     * already-existing installations after the update, instead of
     * silently keeping whatever an older version created. Within a run the
     * objects are not touched again unless the tracker was renamed.
     *
     * @param {string} id sanitized id of the tracker's device object
     * @param {string} name the tracker's own display name
     */
    async ensureDevice(id, name) {
        name = name || id; // an unnamed tracker still needs a usable device name
        const knownName = this.ensuredDevices.get(id);
        if (knownName === name) {
            return;
        }

        if (knownName === undefined) {
            for (const { suffix, obj } of buildDeviceObjects(name)) {
                await this.extendObject(suffix ? `${id}.${suffix}` : id, obj);
            }
        } else {
            await this.extendObject(id, { common: { name } });
        }

        this.ensuredDevices.set(id, name);
        await this.setStateChanged(`${id}.name`, { val: name, ack: true });
    }

    /**
     * Answers the buttons of the configuration page: the setup buttons
     * ("Connect", "Verify and unlock", "Reconnect") work on the values the
     * page sends and hand the result back to the page instead of writing
     * the configuration themselves, so the page can show the next step right
     * away. Two more buttons open Google's unlock page and show the console
     * script in a dialog with a copy button. The log still carries the same
     * instructions as a fallback.
     *
     * @param {ioBroker.Message} obj the message sent by the admin UI
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object' || !obj.command) {
            return;
        }

        const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
        let result;
        try {
            if (obj.command === 'getStep2Url') {
                result = { openUrl: await buildEncryptionUnlockUrl(), window: '_blank' };
            } else if (obj.command === 'getStep2Script') {
                result = {
                    copyDialog: { title: 'Script for the browser console', text: CONSOLE_SNIPPET, type: 'javascript' },
                };
            } else if (obj.command === 'connectAccount') {
                result = await this.connectAccount(message);
            } else if (obj.command === 'unlockEncryption') {
                result = await this.unlockEncryption(message);
            } else if (obj.command === 'resetLogin') {
                result = {
                    native: {
                        oauthToken: '',
                        email: '',
                        androidId: '',
                        securityToken: '',
                        aasToken: '',
                        sharedKeyJson: '',
                        ownerKey: '',
                        ownerKeyVersion: -1,
                        deviceSettings: [],
                    },
                    saveConfig: true,
                };
            } else {
                return; // not ours
            }
        } catch (err) {
            // Mostly input problems (expired or wrongly pasted values), shown to the user in the page.
            this.log.warn(`Could not answer "${obj.command}": ${err.message}`);
            result = { error: err.message };
        }

        if (obj.callback) {
            this.sendTo(obj.from, obj.command, result, obj.callback);
        }
    }

    /**
     * Button "Connect": exchanges the pasted oauth_token and hands the
     * account data back to the configuration page, which applies it to its
     * form (so the page shows the next step right away) and asks to save.
     *
     * @param {{token?: string}} message what the page sent
     * @returns {Promise<object>} the answer for the page
     */
    async connectAccount({ token }) {
        if (typeof token !== 'string' || !token.trim()) {
            return { error: 'Please paste the oauth_token value first.' };
        }
        const account = await this.exchangeLoginToken(token.trim());
        this.log.info('Successfully connected to the Google account.');
        return { native: { oauthToken: '', ...account }, saveConfig: true };
    }

    /**
     * Button "Verify and unlock": turns the pasted browser-console result
     * into the owner key and hands it back to the configuration page.
     *
     * @param {{json?: string, email?: string, aasToken?: string, androidId?: string}} message what the page sent
     * @returns {Promise<object>} the answer for the page
     */
    async unlockEncryption({ json, email, aasToken, androidId }) {
        if (typeof json !== 'string' || !json.trim()) {
            return { error: 'Please paste the result from the browser console first.' };
        }
        if (!email || !aasToken || !androidId) {
            return { error: 'The account is not connected yet - complete Part 1 of the setup first.' };
        }
        const { ownerKey, ownerKeyVersion } = await this.deriveOwnerKey({ email, aasToken, androidId }, json.trim());
        this.log.info('Owner key set up successfully.');
        return { native: { sharedKeyJson: '', ownerKey, ownerKeyVersion }, saveConfig: true };
    }

    /**
     * Stops all timers and the push connection when the adapter shuts down.
     *
     * @param {() => void} callback js-controller's completion callback
     */
    onUnload(callback) {
        try {
            this.unloaded = true;
            if (this.pollTimeout) {
                this.clearTimeout(this.pollTimeout);
            }
            for (const timer of this.locateTimers.values()) {
                this.clearTimeout(timer);
            }
            this.locateTimers.clear();
            this.mcsClient.stop();
            callback();
        } catch (err) {
            this.log.error(`Error during unloading: ${err.message}`);
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new Googlefindmydevice(options);
} else {
    new Googlefindmydevice();
}
