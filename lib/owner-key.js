'use strict';

// Retrieves the FMDN end-to-end-encryption "owner key" - the key needed to
// unwrap each individual tracker's identity key (see fmdn-crypto.js), which
// in turn decrypts its location reports.
//
// Getting there needs two independent pieces:
//  1. A "shared key" that only Google's own accounts.google.com page can
//     produce, since it performs Google's own account-recovery-key unlock
//     ceremony internally. This project deliberately does not automate a
//     browser to obtain it (see README) - the user completes that step
//     manually and pastes back the raw JSON Google's page would otherwise
//     have handed to a real Find My Device app.
//  2. The account's current encrypted owner key blob, fetched from the Spot
//     API (spot-api.js) and decrypted locally with that shared key.
//
// Protocol reference: KeyBackup/response_parser.py and
// KeyBackup/cloud_key_decryptor.py (decrypt_owner_key) in
// leonboe1/GoogleFindMyTools (GPL-3.0).

const crypto = require('node:crypto');
const path = require('node:path');
const protobuf = require('protobufjs');

const { getEidInfoForE2eeDevices } = require('./spot-api');

/**
 * Extracts the "finder_hw" security domain's key from the JSON payload
 * Google's encryption-unlock page would call
 * `window.mm.setVaultSharedKeys(str, vaultKeys)` with.
 *
 * @param {string} vaultKeysJson - the raw vaultKeys JSON string
 * @returns {Buffer}
 */
function extractSharedKeyFromVaultKeys(vaultKeysJson) {
  let parsed;
  try {
    parsed = JSON.parse(vaultKeysJson);
  } catch (err) {
    throw new Error('Das eingefügte Ergebnis ist kein gültiges JSON.');
  }

  const entries = parsed.finder_hw;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Im eingefügten Ergebnis wurde kein "finder_hw"-Schlüssel gefunden.');
  }

  const keyObj = entries[0].key;
  const bytes = Buffer.from(Object.keys(keyObj).map(i => keyObj[i]));
  return bytes;
}

function decryptAesGcm(key, encryptedDataAndIv, ivLength = 12) {
  const iv = encryptedDataAndIv.subarray(0, ivLength);
  const rest = encryptedDataAndIv.subarray(ivLength);
  const tag = rest.subarray(rest.length - 16);
  const ciphertext = rest.subarray(0, rest.length - 16);

  const algo = key.length === 32 ? 'aes-256-gcm' : key.length === 24 ? 'aes-192-gcm' : 'aes-128-gcm';
  const decipher = crypto.createDecipheriv(algo, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * @param {string} spotToken - bearer token for the "spot" service scope
 * @param {Buffer} sharedKey - from extractSharedKeyFromVaultKeys()
 * @returns {Promise<{ownerKey: Buffer, ownerKeyVersion: number}>}
 */
async function retrieveOwnerKey(spotToken, sharedKey) {
  const eidInfo = await getEidInfoForE2eeDevices(spotToken);
  const meta = eidInfo.encryptedOwnerKeyAndMetadata;
  if (!meta || !meta.encryptedOwnerKey) {
    throw new Error('Google hat keinen verschlüsselten Owner Key zurückgegeben.');
  }

  const encryptedOwnerKey = Buffer.isBuffer(meta.encryptedOwnerKey)
    ? meta.encryptedOwnerKey
    : Buffer.from(meta.encryptedOwnerKey, 'base64');

  const ownerKey = decryptAesGcm(sharedKey, encryptedOwnerKey);
  return { ownerKey, ownerKeyVersion: meta.ownerKeyVersion };
}

let protoRoot = null;
async function loadProto() {
  if (protoRoot) return protoRoot;
  protoRoot = await protobuf.load(path.join(__dirname, 'proto', 'device_update.proto'));
  return protoRoot;
}

/**
 * Builds the Google-hosted "encryption unlock" URL the user needs to open
 * manually in their own browser as part of the shared-key step.
 */
async function buildEncryptionUnlockUrl() {
  const root = await loadProto();
  const T = root.lookupType('googlefindmydevice.EncryptionUnlockRequestExtras');
  const msg = T.create({
    operation: 1,
    securityDomain: { name: 'finder_hw', unknown: 0 },
    sessionId: crypto.randomUUID(),
  });
  const b64 = T.encode(msg).finish().toString('base64');
  return `https://accounts.google.com/encryption/unlock/android?kdi=${encodeURIComponent(b64)}`;
}

// The small script the user pastes into their browser's DevTools console on
// the encryption-unlock page. It only ever reads a value Google's own page
// hands it and displays it on the page for the user to copy - it does not
// modify or interact with the page in any other way.
const CONSOLE_SNIPPET = `(function(){
  window.mm = {
    setVaultSharedKeys: function(str, vaultKeys) {
      var el = document.createElement('textarea');
      el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:220px;z-index:999999;background:#fff;color:#000;font-size:11px;padding:8px;box-sizing:border-box;';
      el.value = vaultKeys;
      document.body.prepend(el);
      el.focus();
      el.select();
      console.log('Ergebnis erfasst - siehe Textfeld oben auf der Seite.');
    },
    closeView: function() {
      console.log('closeView() wurde aufgerufen, ohne Daten zu liefern - etwas ist schiefgelaufen.');
    }
  };
  console.log('Listener installiert. Jetzt tun, was Google auf dieser Seite verlangt.');
})();`;

module.exports = {
  extractSharedKeyFromVaultKeys,
  decryptAesGcm,
  retrieveOwnerKey,
  buildEncryptionUnlockUrl,
  CONSOLE_SNIPPET,
};
