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
  assert.deepEqual(result, { semantic: 'Home', timestamp: TIMESTAMP, status: 0, reportCount: 1 });
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

// A device whose answer holds several reports, each with its own time.
function deviceWithReports(reports) {
  const device = deviceWith(undefined);
  device.raw.information.locationInformation.reports = {
    recentLocationAndNetworkLocations: {
      networkLocations: reports.map(r => r.loc),
      networkLocationTimestamps: reports.map(r => ({ seconds: String(r.time) })),
    },
  };
  return device;
}

test('a report that cannot be read is skipped, the newest one that can be read is used', async () => {
  const broken = await foreignReport();
  broken.geoLocation.encryptedReport.encryptedLocation[3] ^= 0xff;
  const skipped = [];
  const result = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([
      { loc: broken, time: TIMESTAMP + 500 },
      { loc: await ownReport(), time: TIMESTAMP },
    ]),
    { onSkip: info => skipped.push(info) },
  );
  assert.equal(result.lat, 52.52);
  assert.equal(result.timestamp, TIMESTAMP);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].keyPartLength, 20);
  assert.equal(skipped[0].ownReport, false);
});

test('a relayed report with a key part of an unknown size is reported as unsupported, with its size', async () => {
  const report = await foreignReport();
  report.geoLocation.encryptedReport.publicKeyRandom = Buffer.alloc(33, 9);
  const skipped = [];
  await assert.rejects(
    decryptLatestLocation(OWNER_KEY, deviceWith(report), { onSkip: info => skipped.push(info) }),
    /Unsupported key part length 33/,
  );
  assert.deepEqual(skipped.map(s => s.keyPartLength), [33]);
});

test('an older readable report is used when the newest one cannot be read', async () => {
  const newer = await foreignReport();
  newer.geoLocation.encryptedReport.publicKeyRandom = Buffer.alloc(33, 9);
  const result = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([
      { loc: newer, time: TIMESTAMP + 60 },
      { loc: await foreignReport(), time: TIMESTAMP },
    ]),
  );
  assert.equal(result.lat, 48.4);
  assert.equal(result.timestamp, TIMESTAMP);
});

test('isOwnReport follows the way the report was decrypted, not the flag from Google', async () => {
  const own = await ownReport();
  own.geoLocation.encryptedReport.isOwnReport = false;
  assert.equal((await decryptLatestLocation(OWNER_KEY, deviceWith(own))).isOwnReport, true);

  const foreign = await foreignReport();
  foreign.geoLocation.encryptedReport.isOwnReport = true;
  assert.equal((await decryptLatestLocation(OWNER_KEY, deviceWith(foreign))).isOwnReport, false);
});

test('reports without a time, or with a time far in the future, are left out', async () => {
  const skipped = [];
  const onSkip = info => skipped.push(info.reason);
  const future = Math.floor(Date.now() / 1000) + 86400;
  const result = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([
      { loc: await foreignReport(), time: future },
      { loc: await foreignReport(), time: 0 },
      { loc: await ownReport(), time: TIMESTAMP },
    ]),
    { onSkip },
  );
  assert.equal(result.timestamp, TIMESTAMP);
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every(reason => /time/.test(reason)));
});

test('a time given in milliseconds is understood', async () => {
  const result = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([{ loc: await ownReport(), time: TIMESTAMP * 1000 }]),
  );
  assert.equal(result.timestamp, TIMESTAMP);
});

test('a newer semantic report wins over an older GPS report, and the other way round', async () => {
  const semantic = { status: 0, semanticLocation: { locationName: 'Home' } };
  const newerSemantic = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([
      { loc: semantic, time: TIMESTAMP + 10 },
      { loc: await ownReport(), time: TIMESTAMP },
    ]),
  );
  assert.deepEqual(newerSemantic, { semantic: 'Home', timestamp: TIMESTAMP + 10, status: 0, reportCount: 2 });

  const newerGps = await decryptLatestLocation(
    OWNER_KEY,
    deviceWithReports([
      { loc: semantic, time: TIMESTAMP },
      { loc: await ownReport(), time: TIMESTAMP + 10 },
    ]),
  );
  assert.equal(newerGps.lat, 52.52);
});

test('a location relayed by a P-256 tracker (32 byte key part) is decrypted and the reading is named', async () => {
  const p256 = require('../lib/fmdn-p256');
  const plain = await encodeLocation(484_000_000, 99_000_000, -3);
  const beaconTimeCounter = 8_704_000;
  const eid = p256.generateEid(IDENTITY_KEY, beaconTimeCounter, 'be_plus_one');
  const { encryptedAndTag, Sx } = p256.encrypt(plain, Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)), eid, 10);
  const report = {
    status: 1,
    geoLocation: {
      accuracy: 25,
      deviceTimeOffset: beaconTimeCounter,
      encryptedReport: { encryptedLocation: encryptedAndTag, publicKeyRandom: Sx, isOwnReport: false },
    },
  };

  const result = await decryptLatestLocation(OWNER_KEY, deviceWith(report));

  assert.equal(result.lat, 48.4);
  assert.equal(result.lon, 9.9);
  assert.equal(result.isOwnReport, false);
  assert.equal(result.keyPartLength, 32);
  assert.equal(result.reading, 'p256/be_plus_one/nonce10');
});
