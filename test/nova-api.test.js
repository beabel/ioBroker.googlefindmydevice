'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const protobuf = require('protobufjs');
const { listDevices } = require('../lib/nova-api');

const UUID = '0b8f0d0e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const lenField = (no, data) => {
  const len = [];
  let n = data.length;
  while (n > 127) {
    len.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  len.push(n);
  return Buffer.concat([Buffer.from([(no << 3) | 2, ...len]), data]);
};
const varintField = (no, value) => Buffer.from([(no << 3) | 0, value]);

async function informationBytes(extra = {}) {
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'device_update.proto'));
  const Information = root.lookupType('googlefindmydevice.DeviceInformation');
  return Buffer.from(
    Information.encode(
      Information.create({
        deviceRegistration: {
          manufacturer: 'Acme Audio',
          model: 'Buds P1',
          fastPairModelId: 'abc123',
          encryptedUserSecrets: { encryptedIdentityKey: crypto.randomBytes(60) },
          ...extra,
        },
      }),
    ).finish(),
  );
}

// Headphones as Google lists them: identifier type 5 with the id in field 5,
// device information in field 10 -> 11 (no field 4).
async function headphoneEntry(identityKey = true) {
  const identifier = Buffer.concat([
    varintField(2, 5),
    lenField(5, lenField(2, lenField(1, lenField(1, Buffer.from(UUID))))),
  ]);
  const info = await informationBytes(identityKey ? {} : { encryptedUserSecrets: null });
  return Buffer.concat([lenField(1, identifier), lenField(5, Buffer.from('My buds')), lenField(10, lenField(11, info))]);
}

function phoneEntry() {
  const identifier = Buffer.concat([lenField(1, lenField(2, lenField(1, lenField(1, Buffer.from(UUID))))), varintField(2, 1)]);
  return Buffer.concat([lenField(1, identifier), lenField(5, Buffer.from('My phone'))]);
}

async function withDeviceList(entries, fn) {
  const realFetch = globalThis.fetch;
  const body = Buffer.concat(entries.map(e => lenField(2, e)));
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('listDevices: headphones with a Find Hub key are listed like trackers', async () => {
  const devices = await withDeviceList([await headphoneEntry(), phoneEntry()], () => listDevices('token'));
  assert.equal(devices.length, 2);
  const [buds, phone] = devices;
  assert.equal(buds.canonicId, UUID);
  assert.equal(buds.manufacturer, 'Acme Audio');
  assert.equal(buds.model, 'Buds P1');
  assert.equal(buds.fastPairModelId, 'abc123');
  assert.equal(buds.name, 'My buds');
  assert.ok(buds.raw.information.deviceRegistration.encryptedUserSecrets.encryptedIdentityKey.length === 60);
  assert.equal(phone.canonicId, null, 'a phone has no device information and stays out');
});

test('listDevices: a Fast Pair device without an identity key is not taken over', async () => {
  const devices = await withDeviceList([await headphoneEntry(false)], () => listDevices('token'));
  assert.equal(devices[0].canonicId, null);
});
