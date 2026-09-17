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
const DEFAULT_CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';

function parseAuthResponse(text) {
  const result = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx === -1) {
      result[line] = '';
    } else {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}

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
 */
async function performOAuth(email, masterToken, androidId, service, app, clientSig, options = {}) {
  const {
    deviceCountry = 'us',
    operatorCountry = 'us',
    lang = 'en',
    sdkVersion = 17,
  } = options;

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
