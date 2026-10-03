'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const protobuf = require('protobufjs');
const fmdn = require('../lib/fmdn-crypto');
const { decryptLatestLocation } = require('../lib/decrypt-locations');

// Builds device entries exactly the way nova-api.js's listDevices() hands
// them over (the decoded protobuf lives under `.raw`), with the encryption
// layers applied by the same primitives a real tracker/Google would use.

const OWNER_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => 100 + i));
const IDENTITY_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const TIMESTAMP = 1_758_000_000;

function aesGcmEncrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

async function encodeLocation(latitude, longitude, altitude) {
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'device_update.proto'));
  const Location = root.lookupType('googlefindmydevice.Location');
  return Buffer.from(Location.encode(Location.create({ latitude, longitude, altitude })).finish());
}

function deviceWith(location, { identityKey = IDENTITY_KEY, ownerKey = OWNER_KEY } = {}) {
  return {
    raw: {
      information: {
        deviceRegistration: {
          fastPairModelId: 'abc123',
          encryptedUserSecrets: { encryptedIdentityKey: aesGcmEncrypt(ownerKey, identityKey) },
        },
        locationInformation: {
          reports: {
            recentLocationAndNetworkLocations: location && {
              recentLocation: location,
              recentLocationTimestamp: { seconds: String(TIMESTAMP) },
            },
          },
        },
      },
    },
  };
}

async function ownReport() {
  const plain = await encodeLocation(525_200_000, 134_050_000, 34); // 52.52, 13.405
  const key = crypto.createHash('sha256').update(IDENTITY_KEY).digest();
  return {
    status: 1,
    geoLocation: {
      accuracy: 12,
      encryptedReport: { encryptedLocation: aesGcmEncrypt(key, plain), isOwnReport: true },
    },
  };
}

async function foreignReport() {
  const plain = await encodeLocation(484_000_000, 99_000_000, -3); // 48.4, 9.9
  const beaconTimeCounter = 8_704_000;
  const eid = fmdn.generateEid(IDENTITY_KEY, beaconTimeCounter);
  const { encryptedAndTag, Sx } = fmdn.encrypt(plain, Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)), eid);
  return {
    status: 1,
    geoLocation: {
      accuracy: 40,
      deviceTimeOffset: beaconTimeCounter,
      encryptedReport: { encryptedLocation: encryptedAndTag, publicKeyRandom: Sx, isOwnReport: false },
    },
  };
}

test('decrypts a location the tracker reported itself', async () => {
  const result = await decryptLatestLocation(OWNER_KEY, deviceWith(await ownReport()));
  assert.equal(result.lat, 52.52);
  assert.equal(result.lon, 13.405);
  assert.equal(result.altitude, 34);
  assert.equal(result.accuracy, 12);
  assert.equal(result.isOwnReport, true);
  assert.equal(result.timestamp, TIMESTAMP);
});

test('decrypts a location relayed by a stranger\'s device (FMDN/ECDH path)', async () => {
  const result = await decryptLatestLocation(OWNER_KEY, deviceWith(await foreignReport()));
  assert.equal(result.lat, 48.4);
  assert.equal(result.lon, 9.9);
  assert.equal(result.altitude, -3);
  assert.equal(result.accuracy, 40);
  assert.equal(result.isOwnReport, false);
});

test('a semantic location ("Home") comes back as text, without coordinates', async () => {
  const result = await decryptLatestLocation(
    OWNER_KEY,
    deviceWith({ status: 0, semanticLocation: { locationName: 'Home' } }),
  );
  assert.deepEqual(result, { semantic: 'Home', timestamp: TIMESTAMP });
});

test('returns null (not an error) while Google has no location report yet', async () => {
  assert.equal(await decryptLatestLocation(OWNER_KEY, deviceWith(undefined)), null);
  assert.equal(await decryptLatestLocation(OWNER_KEY, { raw: { information: null } }), null);
  assert.equal(await decryptLatestLocation(OWNER_KEY, { raw: {} }), null);
  assert.equal(await decryptLatestLocation(OWNER_KEY, {}), null);
});

test('fails cleanly with the wrong owner key', async () => {
  const wrongKey = Buffer.alloc(32, 7);
  await assert.rejects(decryptLatestLocation(wrongKey, deviceWith(await ownReport())), /authenticate|unsupported/i);
});

test('fails cleanly when the encrypted location was tampered with', async () => {
  const report = await ownReport();
  report.geoLocation.encryptedReport.encryptedLocation[20] ^= 0xff;
  await assert.rejects(decryptLatestLocation(OWNER_KEY, deviceWith(report)), /authenticate|unsupported/i);
});

test('fails with a clear message when the identity key is missing or has an unexpected size', async () => {
  const noSecrets = deviceWith(await ownReport());
  delete noSecrets.raw.information.deviceRegistration.encryptedUserSecrets;
  await assert.rejects(decryptLatestLocation(OWNER_KEY, noSecrets), /No encrypted identity key/);

  const oddSize = deviceWith(await ownReport());
  oddSize.raw.information.deviceRegistration.encryptedUserSecrets.encryptedIdentityKey = Buffer.alloc(10);
  await assert.rejects(decryptLatestLocation(OWNER_KEY, oddSize), /Unexpected length/);
});
