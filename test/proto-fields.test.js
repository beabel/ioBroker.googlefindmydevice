'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeStructure, describeIdentifierBlocks } = require('../lib/proto-fields');
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

test('parseHeaderParams: ignores extra parameters after the key', () => {
  assert.deepEqual(parseHeaderParams('dh=abc_-;p256ecdsa=xyz'), { dh: 'abc_-', p256ecdsa: 'xyz' });
  assert.deepEqual(parseHeaderParams('salt=QUJD'), { salt: 'QUJD' });
  assert.deepEqual(parseHeaderParams(undefined), {});
});
