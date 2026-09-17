'use strict';

const utils = require('@iobroker/adapter-core');
const { gcmCheckin } = require('./lib/google-checkin');
const { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG } = require('./lib/google-auth');
const { listDevices } = require('./lib/nova-api');
const { extractSharedKeyFromVaultKeys, retrieveOwnerKey, buildEncryptionUnlockUrl, CONSOLE_SNIPPET } = require('./lib/owner-key');
const { decryptLatestLocation } = require('./lib/decrypt-locations');

const ADM_SERVICE_SCOPE = 'oauth2:https://www.googleapis.com/auth/android_device_manager';
const ADM_APP = 'com.google.android.apps.adm';
const SPOT_SERVICE_SCOPE = 'oauth2:https://www.googleapis.com/auth/spot';
const SPOT_APP = 'com.google.android.gms';

// A number of minutes small enough that minutes * 60 * 1000 never overflows
// setTimeout's 32-bit signed millisecond limit.
const POLL_MIN_MINUTES = 1;
const POLL_MAX_MINUTES = 1440; // 24h

class Googlefindmydevice extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'googlefindmydevice',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.pollTimeout = null;
    }

    async onReady() {
        if (this.config.oauthToken) {
            await this.bootstrapFromOauthToken();
            return; // extendForeignObjectAsync below triggers a restart with the new config
        }

        if (!this.config.aasToken || !this.config.androidId || !this.config.email) {
            this.log.warn(
                'Noch nicht eingerichtet: bitte den oauth_token-Wert in der Instanzkonfiguration eintragen (siehe README).',
            );
            await this.setStateAsync('info.connection', false, true);
            return;
        }

        if (this.config.sharedKeyJson) {
            await this.bootstrapOwnerKey();
            return; // extendForeignObjectAsync below triggers a restart with the new config
        }

        if (!this.config.ownerKey) {
            await this.logStep2Instructions();
        }

        await this.pollLoop();
    }

    async logStep2Instructions() {
        try {
            const url = await buildEncryptionUnlockUrl();
            this.log.info(
                'Standort-Entschluesselung noch nicht eingerichtet (Schritt 2). Geraetenamen werden trotzdem ' +
                    'aktualisiert. Anleitung: 1) Diesen Link in deinem Browser oeffnen: ' +
                    url +
                    ' 2) Entwicklertools oeffnen (F12) -> Reiter "Konsole" -> folgenden Code einfuegen und Enter ' +
                    'druecken: ' +
                    CONSOLE_SNIPPET +
                    ' 3) Auf der Seite tun, was Google verlangt. 4) Das danach oben auf der Seite erscheinende ' +
                    'Textfeld komplett kopieren und in der Instanzkonfiguration bei "Ergebnis aus der ' +
                    'Browser-Konsole" einfuegen und speichern.',
            );
        } catch (err) {
            this.log.error(`Konnte Schritt-2-Anleitung nicht erzeugen: ${err.message}`);
        }
    }

    async bootstrapOwnerKey() {
        try {
            this.log.info('Ergebnis aus Schritt 2 erkannt, hole und entschluessele den Owner Key...');
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

            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: {
                    sharedKeyJson: '',
                    ownerKey: ownerKey.toString('hex'),
                    ownerKeyVersion,
                },
            });

            this.log.info('Owner Key erfolgreich eingerichtet. Adapter startet neu...');
        } catch (err) {
            this.log.error(`Einrichtung von Schritt 2 fehlgeschlagen: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
        }
    }

    async bootstrapFromOauthToken() {
        try {
            this.log.info('Login-Token erkannt, tausche gegen langlebiges Konto-Token...');
            const { androidId, securityToken } = await gcmCheckin();
            const exchangeResult = await exchangeToken('', this.config.oauthToken, androidId);

            if (!exchangeResult.Token || !exchangeResult.Email) {
                throw new Error(
                    'Google hat kein gueltiges Token zurueckgegeben - der oauth_token-Wert ist vermutlich ' +
                        'abgelaufen. Bitte einen frischen Wert eintragen (siehe README).',
                );
            }

            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: {
                    oauthToken: '',
                    email: exchangeResult.Email,
                    androidId,
                    securityToken,
                    aasToken: exchangeResult.Token,
                },
            });

            this.log.info(`Erfolgreich verbunden als ${exchangeResult.Email}. Adapter startet neu...`);
        } catch (err) {
            this.log.error(`Einrichtung fehlgeschlagen: ${err.message}`);
            await this.setStateAsync('info.connection', false, true);
        }
    }

    async pollLoop() {
        try {
            await this.updateDevices();
            await this.setStateAsync('info.connection', true, true);
        } catch (err) {
            this.log.error(`Aktualisierung fehlgeschlagen: ${err.message}`);
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

        const devices = await listDevices(admToken);
        this.log.debug(`${devices.length} Tracker gefunden.`);

        const ownerKey = this.config.ownerKey ? Buffer.from(this.config.ownerKey, 'hex') : null;

        for (const device of devices) {
            const stateId = this.canonicIdToStateId(device.canonicId || device.name);
            await this.ensureDeviceStates(stateId, device.name);

            if (!ownerKey) continue;

            try {
                const location = await decryptLatestLocation(ownerKey, device);
                if (!location) {
                    const info = device.raw && device.raw.information;
                    this.log.debug(
                        `Kein Standortbericht fuer "${device.name}" - hasDeviceRegistration=${!!(info && info.deviceRegistration)}, ` +
                            `hasLocationInformation=${!!(info && info.locationInformation)}, ` +
                            `hasReports=${!!(info && info.locationInformation && info.locationInformation.reports)}, ` +
                            `reports=${JSON.stringify(info && info.locationInformation && info.locationInformation.reports)}`,
                    );
                }
                await this.updateLocationStates(stateId, location);
            } catch (err) {
                this.log.warn(`Standort fuer "${device.name}" konnte nicht entschluesselt werden: ${err.message}`);
            }
        }
    }

    async updateLocationStates(stateId, location) {
        if (!location) return;

        if (location.semantic !== undefined) {
            await this.setStateAsync(`devices.${stateId}.semanticLocation`, { val: location.semantic, ack: true });
            return;
        }

        await this.setStateAsync(`devices.${stateId}.latitude`, { val: location.lat, ack: true });
        await this.setStateAsync(`devices.${stateId}.longitude`, { val: location.lon, ack: true });
        await this.setStateAsync(`devices.${stateId}.altitude`, { val: location.altitude, ack: true });
        await this.setStateAsync(`devices.${stateId}.lastSeen`, { val: location.timestamp * 1000, ack: true });
    }

    canonicIdToStateId(raw) {
        return String(raw || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    async ensureDeviceStates(id, name) {
        await this.setObjectNotExistsAsync(`devices.${id}`, {
            type: 'channel',
            common: { name: { en: name, de: name } },
            native: {},
        });
        await this.setObjectNotExistsAsync(`devices.${id}.name`, {
            type: 'state',
            common: {
                name: { en: 'Device name', de: 'Geraetename' },
                type: 'string',
                role: 'text',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(`devices.${id}.name`, { val: name, ack: true });

        await this.setObjectNotExistsAsync(`devices.${id}.latitude`, {
            type: 'state',
            common: { name: { en: 'Latitude', de: 'Breitengrad' }, type: 'number', role: 'value.gps.latitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`devices.${id}.longitude`, {
            type: 'state',
            common: { name: { en: 'Longitude', de: 'Längengrad' }, type: 'number', role: 'value.gps.longitude', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`devices.${id}.altitude`, {
            type: 'state',
            common: { name: { en: 'Altitude', de: 'Höhe' }, type: 'number', role: 'value.gps.elevation', unit: 'm', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`devices.${id}.lastSeen`, {
            type: 'state',
            common: { name: { en: 'Last seen', de: 'Zuletzt gesehen' }, type: 'number', role: 'value.time', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync(`devices.${id}.semanticLocation`, {
            type: 'state',
            common: {
                name: { en: 'Semantic location (e.g. "Home")', de: 'Semantischer Standort (z.B. "Zuhause")' },
                type: 'string',
                role: 'text',
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
