'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeStructure,
  describeIdentifierBlocks,
  describeDeviceEntries,
  findIdentifierIds,
  readNested,
  fillAlternativeInformation,
} = require('../lib/proto-fields');
const path = require('node:path');
const protobuf = require('protobufjs');
const { parseHeaderParams } = require('../lib/webpush-decrypt');

// field 1 = varint 5, field 2 = string "secret-id"
const flat = Buffer.concat([Buffer.from([0x08, 0x05, 0x12, 9]), Buffer.from('secret-id')]);

test('describeStructure: shows field numbers, sizes and small values but never contents', () => {
  const text = describeStructure(flat);
  assert.equal(text, '1=5,2:len9');
  assert.ok(!text.includes('secret'));
});

test('describeStructure: nested messages are shown, malformed input yields an empty string', () => {
  const nested = Buffer.concat([Buffer.from([0x1a, flat.length]), flat]);
  assert.equal(describeStructure(nested), '3{1=5,2:len9}');
  assert.equal(describeStructure(Buffer.from([0x0a, 0x7f, 0x01])), '');
});

test('describeIdentifierBlocks: one entry per device, taken from field 1 of each device', () => {
  const device = (id) => Buffer.concat([Buffer.from([0x0a, id.length]), id]);
  const wrap = (d) => Buffer.concat([Buffer.from([0x12, d.length]), d]);
  const list = Buffer.concat([wrap(device(flat)), wrap(Buffer.from([0x20, 0x01]))]);
  assert.deepEqual(describeIdentifierBlocks(list), ['1=5,2:len9', '']);
});

// headphone-like entry: identifier { 2=5, 5 { 2 { 1 { 1 = uuid } } } }, then a field 4 block and a name
const UUID = '0b8f0d0e-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const lenField = (no, data) => Buffer.concat([Buffer.from([(no << 3) | 2, data.length]), data]);
const headphones = lenField(
  1,
  Buffer.concat([Buffer.from([0x10, 0x05]), lenField(5, lenField(2, lenField(1, lenField(1, Buffer.from(UUID)))))]),
);
const listOf = (...entries) => Buffer.concat(entries.map(e => lenField(2, e)));

test('findIdentifierIds: finds a UUID inside unknown identifier fields, null where there is none', () => {
  const list = listOf(headphones, Buffer.from([0x20, 0x01]));
  assert.deepEqual(findIdentifierIds(list), [UUID, null]);
});

test('describeDeviceEntries: whole entry, deeper than the identifier view, without contents', () => {
  const entry = Buffer.concat([headphones, lenField(4, lenField(2, Buffer.from('some location data')))]);
  const [text] = describeDeviceEntries(listOf(entry));
  assert.equal(text, '1{2=5,5{2{1{1:len36}}}},4{2:len18}');
  assert.ok(!text.includes(UUID));
});

async function informationType() {
  const root = await protobuf.load(path.join(__dirname, '..', 'lib', 'proto', 'device_update.proto'));
  return root.lookupType('googlefindmydevice.DeviceInformation');
}

test('fillAlternativeInformation: takes the device information from field 10 -> 11 when field 4 is missing', async () => {
  const Information = await informationType();
  const info = Buffer.from(
    Information.encode(
      Information.create({ deviceRegistration: { manufacturer: 'Acme', model: 'Buds', fastPairModelId: 'abc123' } }),
    ).finish(),
  );
  const entry = Buffer.concat([headphones, lenField(10, lenField(11, info))]);
  const metadata = { information: null };
  assert.equal(fillAlternativeInformation(metadata, entry, Information), true);
  assert.equal(metadata.information.deviceRegistration.manufacturer, 'Acme');
  assert.equal(metadata.information.deviceRegistration.model, 'Buds');
});

test('fillAlternativeInformation: leaves entries alone that have field 4 or nothing in field 10', async () => {
  const Information = await informationType();
  const existing = { deviceRegistration: { manufacturer: 'Own' } };
  const withInfo = { information: existing };
  assert.equal(fillAlternativeInformation(withInfo, headphones, Information), false);
  assert.equal(withInfo.information, existing);
  const without = { information: null };
  assert.equal(fillAlternativeInformation(without, headphones, Information), false);
  assert.equal(without.information, null);
  // a field 10 that is not a device information message must not throw
  const garbage = Buffer.concat([headphones, lenField(10, lenField(11, Buffer.from([0xff, 0xff, 0xff])))]);
  assert.equal(fillAlternativeInformation({ information: null }, garbage, Information), false);
});

test('readNested: follows a path of fields, null when it does not exist', () => {
  const buf = lenField(3, lenField(1, Buffer.from('x')));
  assert.deepEqual(readNested(buf, [3, 1]), Buffer.from('x'));
  assert.equal(readNested(buf, [3, 2]), null);
  assert.equal(readNested(buf, [4]), null);
});

test('parseHeaderParams: ignores extra parameters after the key', () => {
  assert.deepEqual(parseHeaderParams('dh=abc_-;p256ecdsa=xyz'), { dh: 'abc_-', p256ecdsa: 'xyz' });
  assert.deepEqual(parseHeaderParams('salt=QUJD'), { salt: 'QUJD' });
  assert.deepEqual(parseHeaderParams(undefined), {});
});

test('readCapabilities: lists the action numbers Google offers for a device', () => {
  const { readCapabilities } = require('../lib/proto-fields');
  const lenField = (no, data) => Buffer.concat([Buffer.from([(no << 3) | 2, data.length]), data]);
  const capability = no => {
    // 2 { 1 { <no>: empty message }, 2 = 1 }
    const tag = no < 16 ? Buffer.from([(no << 3) | 2, 0]) : Buffer.from([((no << 3) | 2) & 0x7f | 0x80, ((no << 3) | 2) >> 7, 0]);
    return lenField(2, Buffer.concat([lenField(1, tag), Buffer.from([0x10, 0x01])]));
  };
  const entry = Buffer.concat([capability(31), capability(30), capability(32)]);
  assert.deepEqual(readCapabilities(entry), [30, 31, 32]);
  assert.deepEqual(readCapabilities(undefined), []);
  assert.deepEqual(readCapabilities(Buffer.alloc(0)), []);
});
