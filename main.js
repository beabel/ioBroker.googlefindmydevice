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

// Fields js-controller auto-decrypts on every startup because they're
// listed in io-package.json's top-level encryptedNative. See
// repairDoubleDecryptedNative() for why that alone isn't enough to trust
// them, and for the per-field validity check right below.
const ENCRYPTED_NATIVE_FIELDS = ['oauthToken', 'aasToken', 'securityToken', 'sharedKeyJson', 'ownerKey'];

/**
 * Whether a decrypted encryptedNative value looks like garbage rather
 * than the real thing. Google's tokens are always plain printable ASCII,
 * ownerKey is always a hex string, and sharedKeyJson is always valid
 * JSON (or empty) - a value that was accidentally run through the
 * repeating-XOR legacy decrypt one extra time will practically always
 * fail one of these checks.
 *
 * @param {string} field one of ENCRYPTED_NATIVE_FIELDS
 * @param {string} value the (decrypted) value to check
 * @returns {boolean}
 */
function looksCorrupted(field, value) {
    if (!value) {
        return false;
    }
    if (field === 'ownerKey') {
        return !/^[0-9a-f]+$/i.test(value);
    }
    if (field === 'sharedKeyJson') {
        try {
            JSON.parse(value);
            return false;
        } catch {
            return true;
        }
    }
    // oauthToken, aasToken, securityToken: plain printable ASCII tokens
    return /[^\x20-\x7E]/.test(value);
}

// Full 11-language common.name translations for the states created in
// ensureDeviceStates() below - the ioBroker repository checker's object
// structure check (W1001) expects every i18n name object to carry all of
// en/de/ru/pt/nl/fr/it/es/pl/uk/zh-cn, not just en/de.
const I18N = {
    deviceName: {
        en: 'Device name',
        de: 'Geraetename',
        ru: 'Имя устройства',
        pt: 'Nome do dispositivo',
        nl: 'Apparaatnaam',
        fr: "Nom de l'appareil",
        it: 'Nome del dispositivo',
        es: 'Nombre del dispositivo',
        pl: 'Nazwa urządzenia',
        uk: 'Назва пристрою',
        'zh-cn': '设备名称',
    },
    manufacturer: {
        en: 'Manufacturer',
        de: 'Hersteller',
        ru: 'Производитель',
        pt: 'Fabricante',
        nl: 'Fabrikant',
        fr: 'Fabricant',
        it: 'Produttore',
        es: 'Fabricante',
        pl: 'Producent',
        uk: 'Виробник',
        'zh-cn': '制造商',
    },
    model: {
        en: 'Model',
        de: 'Modell',
        ru: 'Модель',
        pt: 'Modelo',
        nl: 'Model',
        fr: 'Modèle',
        it: 'Modello',
        es: 'Modelo',
        pl: 'Model',
        uk: 'Модель',
        'zh-cn': '型号',
    },
    fastPairModelId: {
        en: 'Fast Pair model ID',
        de: 'Fast-Pair-Modell-ID',
        ru: 'ID модели Fast Pair',
        pt: 'ID do modelo Fast Pair',
        nl: 'Fast Pair-model-ID',
        fr: 'ID de modèle Fast Pair',
        it: 'ID modello Fast Pair',
        es: 'ID de modelo Fast Pair',
        pl: 'ID modelu Fast Pair',
        uk: 'ID моделі Fast Pair',
        'zh-cn': 'Fast Pair 型号 ID',
    },
    deviceType: {
        en: 'Device type',
        de: 'Geraetetyp',
        ru: 'Тип устройства',
        pt: 'Tipo de dispositivo',
        nl: 'Apparaattype',
        fr: "Type d'appareil",
        it: 'Tipo di dispositivo',
        es: 'Tipo de dispositivo',
        pl: 'Typ urządzenia',
        uk: 'Тип пристрою',
        'zh-cn': '设备类型',
    },
    pairDate: {
        en: 'Paired since',
        de: 'Gekoppelt seit',
        ru: 'Сопряжено с',
        pt: 'Emparelhado desde',
        nl: 'Gekoppeld sinds',
        fr: 'Associé depuis',
        it: 'Associato dal',
        es: 'Emparejado desde',
        pl: 'Sparowano od',
        uk: 'Спарено з',
        'zh-cn': '配对时间',
    },
    sharedWithCount: {
        en: 'Shared with (people)',
        de: 'Geteilt mit (Personen)',
        ru: 'Общий доступ (люди)',
        pt: 'Compartilhado com (pessoas)',
        nl: 'Gedeeld met (personen)',
        fr: 'Partagé avec (personnes)',
        it: 'Condiviso con (persone)',
        es: 'Compartido con (personas)',
        pl: 'Udostępniono (osoby)',
        uk: 'Спільний доступ (люди)',
        'zh-cn': '共享给(人数)',
    },
    latitude: {
        en: 'Latitude',
        de: 'Breitengrad',
        ru: 'Широта',
        pt: 'Latitude',
        nl: 'Breedtegraad',
        fr: 'Latitude',
        it: 'Latitudine',
        es: 'Latitud',
        pl: 'Szerokość geograficzna',
        uk: 'Широта',
        'zh-cn': '纬度',
    },
    longitude: {
        en: 'Longitude',
        de: 'Längengrad',
        ru: 'Долгота',
        pt: 'Longitude',
        nl: 'Lengtegraad',
        fr: 'Longitude',
        it: 'Longitudine',
        es: 'Longitud',
        pl: 'Długość geograficzna',
        uk: 'Довгота',
        'zh-cn': '经度',
    },
    altitude: {
        en: 'Altitude',
        de: 'Höhe',
        ru: 'Высота',
        pt: 'Altitude',
        nl: 'Hoogte',
        fr: 'Altitude',
        it: 'Altitudine',
        es: 'Altitud',
        pl: 'Wysokość',
        uk: 'Висота',
        'zh-cn': '海拔',
    },
    lastSeen: {
        en: 'Last seen',
        de: 'Zuletzt gesehen',
        ru: 'Последнее обнаружение',
        pt: 'Visto pela última vez',
        nl: 'Laatst gezien',
        fr: 'Vu pour la dernière fois',
        it: 'Ultimo avvistamento',
        es: 'Visto por última vez',
        pl: 'Ostatnio widziany',
        uk: 'Востаннє виявлено',
        'zh-cn': '最后出现时间',
    },
    semanticLocation: {
        en: 'Semantic location (e.g. "Home")',
        de: 'Semantischer Standort (z.B. "Zuhause")',
        ru: 'Смысловое местоположение (например, "Дом")',
        pt: 'Localização semântica (ex.: "Casa")',
        nl: 'Semantische locatie (bijv. "Thuis")',
        fr: 'Emplacement sémantique (p. ex. « Domicile »)',
        it: 'Posizione semantica (es. "Casa")',
        es: 'Ubicación semántica (p. ej., "Casa")',
        pl: 'Lokalizacja semantyczna (np. "Dom")',
        uk: 'Смислове місцезнаходження (напр., "Дім")',
        'zh-cn': '语义位置(例如"家")',
    },
    accuracy: {
        en: 'Accuracy',
        de: 'Genauigkeit',
        ru: 'Точность',
        pt: 'Precisão',
        nl: 'Nauwkeurigheid',
        fr: 'Précision',
        it: 'Precisione',
        es: 'Precisión',
        pl: 'Dokładność',
        uk: 'Точність',
        'zh-cn': '精度',
    },
    isOwnReport: {
        en: 'Reported directly by the tracker (not via a stranger nearby)',
        de: 'Direkt vom Tracker gemeldet (nicht ueber ein fremdes Geraet in der Naehe)',
        ru: 'Сообщено напрямую трекером (не через постороннее устройство поблизости)',
        pt: 'Reportado diretamente pelo rastreador (não por meio de um dispositivo estranho por perto)',
        nl: 'Direct gemeld door de tracker (niet via een onbekend apparaat in de buurt)',
        fr: 'Signalé directement par le traceur (pas via un appareil étranger à proximité)',
        it: 'Segnalato direttamente dal tracker (non tramite un dispositivo sconosciuto nelle vicinanze)',
        es: 'Informado directamente por el rastreador (no a través de un dispositivo desconocido cercano)',
        pl: 'Zgłoszone bezpośrednio przez lokalizator (nie za pośrednictwem obcego urządzenia w pobliżu)',
        uk: 'Повідомлено безпосередньо трекером (не через сторонній пристрій поблизу)',
        'zh-cn': '由追踪器直接报告(而非通过附近的陌生设备)',
    },
    mapsLink: {
        en: 'Google Maps link',
        de: 'Google-Maps-Link',
        ru: 'Ссылка на Google Maps',
        pt: 'Link do Google Maps',
        nl: 'Google Maps-link',
        fr: 'Lien Google Maps',
        it: 'Link di Google Maps',
        es: 'Enlace de Google Maps',
        pl: 'Link do Google Maps',
        uk: 'Посилання на Google Maps',
        'zh-cn': 'Google 地图链接',
    },
};

class Googlefindmydevice extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'googlefindmydevice',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.pollTimeout = null;
        this.locateTimers = new Map();
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

    async onReady() {
        if (await this.repairDoubleDecryptedNative()) {
            return; // updateConfig() above already triggers a restart with the corrected values
        }

        if (this.config.oauthToken) {
            await this.bootstrapFromOauthToken();
            return; // updateConfig() inside it triggers a restart with the new config
        }

        if (!this.config.aasToken || !this.config.androidId || !this.config.email) {
            this.log.warn(
                'Not set up yet: please enter the oauth_token value in the instance configuration (see README).',
            );
            await this.setStateAsync('info.connection', false, true);
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
     * extendForeignObjectAsync() calls (now fixed to use updateConfig()
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
                'Location decryption not set up yet (Step 2). Device names are still being updated in the meantime.',
            );
        } catch (err) {
            this.log.error(`Could not generate Step 2 instructions: ${err.message}`);
        }
    }

    async bootstrapOwnerKey() {
        try {
            this.log.info('Step 2 result detected, fetching and decrypting the owner key...');
            const sharedKey = extractSharedKeyFromVaultKeys(this.config.sharedKeyJson);

            const { Auth: spotToken } = await performOAuth(
                this.config.email,
                this.config.aasToken,
                this.config.androidId,
                SPOT_SERVICE_SCOPE,
                SPOT_APP,
                DEFAULT_CLIENT_SIG,
            );

            const { ownerKey, ownerKeyVersion } = await retrieveOwnerKey(spotToken, sharedKey);

            // updateConfig() (not extendForeignObjectAsync) so these
            // encryptedNative fields actually get encrypted at rest -
            // js-controller decrypts them again on the next startup.
            await this.updateConfig({
                sharedKeyJson: '',
                ownerKey: ownerKey.toString('hex'),
                ownerKeyVersion,
            });

            this.log.info('Owner key set up successfully. Adapter is restarting...');
        } catch (err) {
            this.log.error(`Step 2 setup failed: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
            // Clear it so a bad/expired value doesn't get retried forever on
            // every restart, and so the field is guaranteed empty for a
            // fresh attempt instead of silently keeping the failed one.
            await this.updateConfig({ sharedKeyJson: '' });
        }
    }

    async bootstrapFromOauthToken() {
        try {
            this.log.info('Login token detected, exchanging it for a long-lived account token...');
            const { androidId, securityToken } = await gcmCheckin();
            const exchangeResult = await exchangeToken('', this.config.oauthToken, androidId);

            if (!exchangeResult.Token || !exchangeResult.Email) {
                throw new Error(
                    'Google did not return a valid token - the oauth_token value has probably expired. ' +
                        'Please enter a fresh value (see README).',
                );
            }

            // updateConfig() (not extendForeignObjectAsync) so these
            // encryptedNative fields actually get encrypted at rest -
            // js-controller decrypts them again on the next startup.
            await this.updateConfig({
                oauthToken: '',
                email: exchangeResult.Email,
                androidId,
                securityToken,
                aasToken: exchangeResult.Token,
            });

            this.log.info(`Successfully connected as ${exchangeResult.Email}. Adapter is restarting...`);
        } catch (err) {
            this.log.error(`Setup failed: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
            // Clear it so an expired/invalid oauth_token doesn't get retried
            // forever on every restart, and so the field is guaranteed empty
            // for a fresh paste instead of silently keeping the failed one.
            await this.updateConfig({ oauthToken: '' });
        }
    }

    async pollLoop() {
        try {
            await this.updateDevices();
            await this.setStateAsync('info.connection', true, true);
        } catch (err) {
            this.log.error(`Update failed: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
        }

        const minutes = Math.min(POLL_MAX_MINUTES, Math.max(POLL_MIN_MINUTES, Number(this.config.pollInterval) || 15));
        this.pollTimeout = this.setTimeout(() => this.pollLoop(), minutes * 60 * 1000);
    }

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
        await this.cleanupNonTrackerDevices(devices);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;

        for (const device of devices) {
            const stateId = this.canonicIdToStateId(device.canonicId || device.name);
            await this.ensureDeviceStates(stateId, device.name);
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

    async updateDeviceMetadataStates(stateId, device) {
        await this.setStateAsync(`devices.${stateId}.manufacturer`, { val: device.manufacturer || '', ack: true });
        await this.setStateAsync(`devices.${stateId}.model`, { val: device.model || '', ack: true });
        await this.setStateAsync(`devices.${stateId}.fastPairModelId`, {
            val: device.fastPairModelId || '',
            ack: true,
        });
        await this.setStateAsync(`devices.${stateId}.deviceType`, { val: device.deviceType || '', ack: true });
        await this.setStateAsync(`devices.${stateId}.pairDate`, {
            val: device.pairDate ? device.pairDate * 1000 : null,
            ack: true,
        });
        await this.setStateAsync(`devices.${stateId}.sharedWithCount`, { val: device.sharedWithCount || 0, ack: true });
    }

    /**
     * Adds newly discovered trackers to native.deviceSettings (used by the
     * admin UI's per-device table, see admin/jsonConfig.json) with "locate"
     * disabled by default - fetching a fresh location pings the tracker over
     * BLE and costs it battery, so that has to be an opt-in per device
     * rather than something this adapter turns on automatically.
     *
     * @param devices
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
        await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
            native: { deviceSettings: existing.concat(missing) },
        });
    }

    /**
     * Removes any devices.* channel that isn't a current tracker - phones,
     * tablets and other non-tracker devices used to get one too (before
     * listDevices() results were filtered down to actual trackers), and
     * ioBroker doesn't drop objects on its own just because a poll stops
     * touching them.
     *
     * @param devices
     */
    async cleanupNonTrackerDevices(devices) {
        const currentIds = new Set(devices.map(d => this.canonicIdToStateId(d.canonicId)));
        const allObjects = await this.getAdapterObjectsAsync();
        const prefix = `${this.namespace}.devices.`;

        for (const id of Object.keys(allObjects)) {
            if (!id.startsWith(prefix) || allObjects[id].type !== 'channel') {
                continue;
            }
            const deviceId = id.slice(prefix.length);
            if (!currentIds.has(deviceId)) {
                this.log.info(`Removing "${deviceId}" from the object tree (not a Bluetooth tracker).`);
                await this.delObjectAsync(id, { recursive: true });
            }
        }
    }

    /**
     * Registers with FCM and opens the persistent MCS push connection, once
     * per adapter run, so triggerLocate() can wait for the asynchronous
     * answer to a "locate now" request.
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

            const minutes = Math.min(
                LOCATE_MAX_MINUTES,
                Math.max(LOCATE_MIN_MINUTES, Number(setting.intervalMinutes) || 60),
            );

            const scheduleNext = delayMs => {
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
     * @param canonicId
     * @param name
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

        const stateId = this.canonicIdToStateId(canonicId);
        const location = await decryptLatestLocation(ownerKey, { raw: deviceUpdate.deviceMetadata });
        await this.updateLocationStates(stateId, location);
        if (location) {
            this.log.debug(`Location for "${name}" updated.`);
        }
    }

    async updateLocationStates(stateId, location) {
        if (!location) {
            return;
        }

        // The timestamp tells you how fresh this report actually is, whether
        // it's a semantic ("Home") or a GPS report - always set it either way.
        await this.setStateAsync(`devices.${stateId}.lastSeen`, { val: location.timestamp * 1000, ack: true });

        if (location.semantic !== undefined) {
            await this.setStateAsync(`devices.${stateId}.semanticLocation`, { val: location.semantic, ack: true });
            // A semantic report has no coordinates of its own - clear the
            // GPS-only fields so they don't keep showing an older report's
            // accuracy/link as if it still applied.
            await this.setStateAsync(`devices.${stateId}.accuracy`, { val: null, ack: true });
            await this.setStateAsync(`devices.${stateId}.isOwnReport`, { val: null, ack: true });
            await this.setStateAsync(`devices.${stateId}.mapsLink`, { val: '', ack: true });
            return;
        }

        await this.setStateAsync(`devices.${stateId}.latitude`, { val: location.lat, ack: true });
        await this.setStateAsync(`devices.${stateId}.longitude`, { val: location.lon, ack: true });
        await this.setStateAsync(`devices.${stateId}.altitude`, { val: location.altitude, ack: true });
        await this.setStateAsync(`devices.${stateId}.accuracy`, { val: location.accuracy, ack: true });
        await this.setStateAsync(`devices.${stateId}.isOwnReport`, { val: !!location.isOwnReport, ack: true });
        await this.setStateAsync(`devices.${stateId}.mapsLink`, {
            val: `https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lon}`,
            ack: true,
        });
    }

    canonicIdToStateId(raw) {
        return String(raw || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * Creates/updates the object tree for one device. Uses extendObjectAsync
     * (not setObjectNotExistsAsync) so that object definitions - common.name,
     * common.role, etc. - actually get updated on already-existing
     * installations when this code changes between adapter versions,
     * instead of silently keeping whatever was created by an older version
     * forever. The extra writes on every poll are negligible at this scale
     * (a handful of trackers, polled every few minutes).
     *
     * @param {string} id sanitized state id for this device (see canonicIdToStateId)
     * @param {string} name the device's own display name
     */
    async ensureDeviceStates(id, name) {
        // The channel's name is the device's own (arbitrary, user-chosen) name,
        // not translatable adapter text - a plain string, not an i18n object.
        await this.extendObjectAsync(`devices.${id}`, {
            type: 'channel',
            common: { name },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.name`, {
            type: 'state',
            common: {
                name: I18N.deviceName,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(`devices.${id}.name`, { val: name, ack: true });

        await this.extendObjectAsync(`devices.${id}.manufacturer`, {
            type: 'state',
            common: {
                name: I18N.manufacturer,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.model`, {
            type: 'state',
            common: { name: I18N.model, type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.fastPairModelId`, {
            type: 'state',
            common: {
                name: I18N.fastPairModelId,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.deviceType`, {
            type: 'state',
            common: {
                name: I18N.deviceType,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.pairDate`, {
            type: 'state',
            common: {
                name: I18N.pairDate,
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.sharedWithCount`, {
            type: 'state',
            common: {
                name: I18N.sharedWithCount,
                type: 'number',
                role: 'value',
                read: true,
                write: false,
            },
            native: {},
        });

        await this.extendObjectAsync(`devices.${id}.latitude`, {
            type: 'state',
            common: {
                name: I18N.latitude,
                type: 'number',
                role: 'value.gps.latitude',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.longitude`, {
            type: 'state',
            common: {
                name: I18N.longitude,
                type: 'number',
                role: 'value.gps.longitude',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.altitude`, {
            type: 'state',
            common: {
                name: I18N.altitude,
                type: 'number',
                role: 'value.gps.elevation',
                unit: 'm',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.lastSeen`, {
            type: 'state',
            common: {
                name: I18N.lastSeen,
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.semanticLocation`, {
            type: 'state',
            common: {
                name: I18N.semanticLocation,
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.accuracy`, {
            type: 'state',
            common: {
                name: I18N.accuracy,
                type: 'number',
                role: 'value',
                unit: 'm',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.isOwnReport`, {
            type: 'state',
            common: {
                name: I18N.isOwnReport,
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.extendObjectAsync(`devices.${id}.mapsLink`, {
            type: 'state',
            common: {
                name: I18N.mapsLink,
                type: 'string',
                role: 'text.url',
                read: true,
                write: false,
            },
            native: {},
        });
    }

    onUnload(callback) {
        try {
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
