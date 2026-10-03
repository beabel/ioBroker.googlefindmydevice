'use strict';

const crypto = require('node:crypto');
const utils = require('@iobroker/adapter-core');
const { gcmCheckin } = require('./lib/google-checkin');
const { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG } = require('./lib/google-auth');
const { listDevices, executeLocateAction } = require('./lib/nova-api');
const {
    extractSharedKeyFromVaultKeys,
    retrieveOwnerKey,
    buildEncryptionUnlockUrl,
    CONSOLE_SNIPPET,
} = require('./lib/owner-key');
const { decryptLatestLocation } = require('./lib/decrypt-locations');
const { registerFcm } = require('./lib/fcm-register');
const { McsClient } = require('./lib/mcs-client');
const { ENCRYPTED_NATIVE_FIELDS, looksCorrupted, clampMinutes, canonicIdToStateId } = require('./lib/util');
const { buildDeviceObjects } = require('./lib/objects');

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
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.unloaded = false;
        this.pollTimeout = null;
        this.locateTimers = new Map();
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

            this.log.info(`Successfully connected as ${account.email}. Adapter is restarting...`);
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
        this.log.debug(`${devices.length} tracker(s) found (out of ${allDevices.length} devices in the account).`);

        await this.syncDeviceSettings(devices);
        await this.cleanupStaleDevices(devices);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;

        for (const device of devices) {
            const stateId = canonicIdToStateId(device.canonicId);
            await this.ensureDevice(stateId, device.name);
            await this.updateDeviceMetadataStates(stateId, device);

            if (!ownerKey) {
                continue;
            }

            try {
                const location = await decryptLatestLocation(ownerKey, device);
                if (!location) {
                    this.log.debug(
                        `No location report for "${device.name}" yet (none fetched so far, or cache empty).`,
                    );
                } else {
                    this.log.debug(`Decrypted location for "${device.name}": ${JSON.stringify(location)}`);
                }
                await this.updateLocationStates(stateId, location);
            } catch (err) {
                this.log.warn(`Could not decrypt location for "${device.name}": ${err.message}`);
            }
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
            .map(d => ({ canonicId: d.canonicId, name: d.name, locate: false, intervalMinutes: 60 }));

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
            await this.mcsClient.start({
                androidId: this.config.androidId,
                securityToken: this.config.securityToken,
                ...this.fcmIdentity,
            });
        })();

        return this.fcmReadyPromise;
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
                        await this.triggerLocate(setting.canonicId, setting.name);
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
     * Actively asks Google to ping one tracker for a fresh location, then
     * waits for the asynchronous FCM push answer and decrypts it.
     *
     * @param {string} canonicId Google's canonic id of the tracker
     * @param {string} name the tracker's display name (for log messages)
     */
    async triggerLocate(canonicId, name) {
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
        const responsePromise = this.mcsClient.waitForDeviceUpdate(requestUuid, LOCATE_RESPONSE_TIMEOUT_MS);
        // Mark it as handled right away so Node doesn't log an "unhandled
        // promise rejection" if this settles (e.g. the connection drops)
        // before execution below reaches the real `await responsePromise`.
        responsePromise.catch(() => {});

        this.log.debug(`Requesting current location for "${name}"...`);
        await executeLocateAction(admToken, {
            canonicId,
            fcmRegistrationId: this.fcmIdentity.fcmToken,
            requestUuid,
            fmdClientUuid: this.fmdClientUuid,
        });

        const deviceUpdate = await responsePromise;
        this.log.debug(`Push response for "${name}" received.`);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;
        if (!ownerKey || !deviceUpdate.deviceMetadata) {
            return;
        }

        const stateId = canonicIdToStateId(canonicId);
        // The first poll normally created the objects already; make sure
        // they exist even if it failed, so the states below never end up
        // without an object.
        await this.ensureDevice(stateId, name);
        const location = await decryptLatestLocation(ownerKey, { raw: deviceUpdate.deviceMetadata });
        await this.updateLocationStates(stateId, location);
        if (location) {
            this.log.debug(`Location for "${name}" updated.`);
        }
    }

    /**
     * Writes a decrypted location report into the tracker's states.
     *
     * @param {string} stateId sanitized id of the tracker's device object
     * @param {object | null} location the decrypted report, or null if there is none yet
     */
    async updateLocationStates(stateId, location) {
        if (!location) {
            return;
        }

        // The timestamp tells you how fresh this report actually is, whether
        // it's a semantic ("Home") or a GPS report - always set it either way.
        await this.setStateChanged(`${stateId}.lastSeen`, { val: location.timestamp * 1000, ack: true });

        if (location.semantic !== undefined) {
            await this.setStateChanged(`${stateId}.semanticLocation`, { val: location.semantic, ack: true });
            // A semantic report has no coordinates of its own - clear the
            // GPS-only fields so they don't keep showing an older report's
            // accuracy/link as if it still applied.
            await this.setStateChanged(`${stateId}.accuracy`, { val: null, ack: true });
            await this.setStateChanged(`${stateId}.isOwnReport`, { val: null, ack: true });
            await this.setStateChanged(`${stateId}.mapsLink`, { val: '', ack: true });
            return;
        }

        await this.setStateChanged(`${stateId}.latitude`, { val: location.lat, ack: true });
        await this.setStateChanged(`${stateId}.longitude`, { val: location.lon, ack: true });
        await this.setStateChanged(`${stateId}.altitude`, { val: location.altitude, ack: true });
        await this.setStateChanged(`${stateId}.accuracy`, { val: location.accuracy, ack: true });
        await this.setStateChanged(`${stateId}.isOwnReport`, { val: !!location.isOwnReport, ack: true });
        await this.setStateChanged(`${stateId}.mapsLink`, {
            val: `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`,
            ack: true,
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
        this.log.info(`Successfully connected as ${account.email}.`);
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
