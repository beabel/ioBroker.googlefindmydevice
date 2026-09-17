'use strict';

const utils = require('@iobroker/adapter-core');
const { gcmCheckin } = require('./lib/google-checkin');
const { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG } = require('./lib/google-auth');
const { listDevices } = require('./lib/nova-api');

const ADM_SERVICE_SCOPE = 'oauth2:https://www.googleapis.com/auth/android_device_manager';
const ADM_APP = 'com.google.android.apps.adm';

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

        await this.pollLoop();
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

        for (const device of devices) {
            const stateId = this.canonicIdToStateId(device.canonicId || device.name);
            await this.ensureDeviceStates(stateId, device.name);
            // Standort-Entschluesselung braucht den Owner Key (kommt in einem
            // spaeteren Schritt) - aktuell wird nur der Geraetename angezeigt.
        }
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
