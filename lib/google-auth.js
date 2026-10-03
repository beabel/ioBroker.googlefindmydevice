'use strict';

// Node.js re-implementation of the relevant parts of the well-established
// Python `gpsoauth` library (https://github.com/simon-weber/gpsoauth, MIT,
// (c) Simon Weber) - "a python client library for Google Play Services
// OAuth". Field names and constants below are taken directly from that
// library's exchange_token()/perform_oauth() functions so they match a
// known-working reference rather than being reconstructed from memory.
//
// This module only implements the oauth_token -> master token -> scoped
// service token path (no raw email/password login).

const AUTH_URL = 'https://android.clients.google.com/auth';
const USER_AGENT = 'GoogleAuth/1.4';
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';

/**
 * Parses Google's plain-text "key=value" per line auth response.
 *
 * @param {string} text the raw response body
 * @returns {Record<string, string>} the parsed fields
 */
function parseAuthResponse(text) {
    const entries = text
        .split('\n')
        .filter(line => line)
        .map(line => {
            const idx = line.indexOf('=');
            return idx === -1 ? [line, ''] : [line.slice(0, idx), line.slice(idx + 1)];
        });
    return Object.fromEntries(entries);
}

/**
 * Sends one request to Google's auth endpoint and parses the answer.
 *
 * @param {Record<string, string | number>} data the form fields to send
 * @returns {Promise<Record<string, string>>} the parsed response fields
 */
async function performAuthRequest(data) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
        body.append(key, String(value));
    }

    const response = await fetch(AUTH_URL, {
        method: 'POST',
        headers: {
            'Accept-Encoding': 'identity',
            'Content-type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
        },
        body: body.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    const text = await response.text();
    const parsed = parseAuthResponse(text);

    if (parsed.Error) {
        throw new Error(`Google auth error: ${parsed.Error}`);
    }

    return parsed;
}

/**
 * Exchanges a web oauth_token (obtained via an interactive browser login)
 * for a long-lived master/AAS token.
 *
 * @param {string} email account email (may be empty for the initial exchange)
 * @param {string} token the web oauth_token
 * @param {string} androidId the GCM android id
 * @param {object} [options] optional overrides (service, country codes, language, sdk version, client signature)
 * @returns {Promise<Record<string, string>>} Google's key/value response, including the master token
 */
async function exchangeToken(email, token, androidId, options = {}) {
    const {
        service = 'ac2dm',
        deviceCountry = 'us',
        operatorCountry = 'us',
        lang = 'en',
        sdkVersion = 17,
        clientSig = DEFAULT_CLIENT_SIG,
    } = options;

    const result = await performAuthRequest({
        accountType: 'HOSTED_OR_GOOGLE',
        Email: email,
        has_permission: 1,
        add_account: 1,
        ACCESS_TOKEN: 1,
        Token: token,
        service,
        source: 'android',
        androidId,
        device_country: deviceCountry,
        operatorCountry,
        lang,
        sdk_version: sdkVersion,
        google_play_services_version: 240913000,
        client_sig: clientSig,
        callerSig: clientSig,
        droidguard_results: 'dummy123',
    });

    if (!result.Token) {
        throw new Error('exchangeToken: response did not contain a master token (Token field)');
    }

    return result; // result.Token is the master/AAS token
}

/**
 * Uses a master/AAS token to derive a scoped bearer token for a specific
 * Google service + app identity. `service` must be the full OAuth2 scope
 * URL, e.g. service="oauth2:https://www.googleapis.com/auth/android_device_manager",
 * app="com.google.android.apps.adm" (a bare scope name like
 * "android_device_manager" gets rejected with a BadRequest error).
 *
 * @param {string} email the account email
 * @param {string} masterToken the master/AAS token
 * @param {string} androidId the GCM android id
 * @param {string} service the full OAuth2 scope URL
 * @param {string} app the Android package name to act as
 * @param {string} clientSig the app's client signature
 * @param {object} [options] optional overrides (country codes, language, sdk version)
 * @returns {Promise<Record<string, string>>} Google's key/value response, including the scoped bearer token (Auth)
 */
async function performOAuth(email, masterToken, androidId, service, app, clientSig, options = {}) {
    const { deviceCountry = 'us', operatorCountry = 'us', lang = 'en', sdkVersion = 17 } = options;

    const result = await performAuthRequest({
        accountType: 'HOSTED_OR_GOOGLE',
        Email: email,
        has_permission: 1,
        EncryptedPasswd: masterToken,
        service,
        source: 'android',
        androidId,
        app,
        client_sig: clientSig,
        device_country: deviceCountry,
        operatorCountry,
        lang,
        sdk_version: sdkVersion,
        google_play_services_version: 240913000,
    });

    if (!result.Auth) {
        throw new Error('performOAuth: response did not contain a service token (Auth field)');
    }

    return result; // result.Auth is the scoped bearer token
}

module.exports = { exchangeToken, performOAuth, DEFAULT_CLIENT_SIG };
