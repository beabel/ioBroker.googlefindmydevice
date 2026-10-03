'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDeviceObjects, DEVICE_STATES, I18N } = require('../lib/objects');

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

test('the tracker itself is a device object, defined first, with its own name', () => {
  const [first, ...rest] = buildDeviceObjects('Bike lock');
  assert.equal(first.suffix, '');
  assert.equal(first.obj.type, 'device');
  assert.equal(first.obj.common.name, 'Bike lock');
  assert.ok(rest.length > 0);
  assert.ok(rest.every(entry => entry.obj.type === 'state'));
});

test('a state never has children and every suffix is a single, unique segment', () => {
  const suffixes = buildDeviceObjects('x')
    .slice(1)
    .map(entry => entry.suffix);
  assert.equal(new Set(suffixes).size, suffixes.length, 'duplicate state ids');
  for (const suffix of suffixes) {
    assert.match(suffix, /^[A-Za-z][A-Za-z0-9]*$/, `"${suffix}" must be one plain id segment`);
  }
});

test('every state is read-only, typed, and uses a specific role', () => {
  for (const { suffix, obj } of buildDeviceObjects('x').slice(1)) {
    assert.equal(obj.common.read, true, `${suffix}: read`);
    assert.equal(obj.common.write, false, `${suffix}: write (there is no onStateChange handler)`);
    assert.ok(['string', 'number', 'boolean'].includes(obj.common.type), `${suffix}: type`);
    assert.ok(obj.common.role && obj.common.role !== 'state', `${suffix}: role`);
    assert.notEqual(obj.common.role, 'weblink', `${suffix}: weblink is not a valid role`);
  }
});

test('roles match the declared types (value.time needs a number, text.url a string)', () => {
  const byKey = Object.fromEntries(DEVICE_STATES.map(s => [s.key, s]));
  assert.equal(byKey.pairDate.role, 'value.time');
  assert.equal(byKey.pairDate.type, 'number');
  assert.equal(byKey.lastSeen.role, 'value.time');
  assert.equal(byKey.lastSeen.type, 'number');
  assert.equal(byKey.mapsLink.role, 'text.url');
  assert.equal(byKey.mapsLink.type, 'string');
  assert.equal(byKey.latitude.role, 'value.gps.latitude');
  assert.equal(byKey.longitude.role, 'value.gps.longitude');
});

test('every state name carries all 11 recommended languages, none empty', () => {
  for (const { suffix, obj } of buildDeviceObjects('x').slice(1)) {
    for (const lang of LANGUAGES) {
      assert.ok(
        typeof obj.common.name[lang] === 'string' && obj.common.name[lang].trim() !== '',
        `${suffix}: name is missing the "${lang}" translation`,
      );
    }
  }
});

test('the English name is English text, not a copy of another language', () => {
  for (const [key, names] of Object.entries(I18N)) {
    assert.ok(/^[\x20-\x7E]+$/.test(names.en), `${key}: English name must be plain ASCII English text`);
  }
});

test('the device name is passed through unchanged (it is arbitrary user data)', () => {
  const [device] = buildDeviceObjects('Ünïcode "Tracker" 1');
  assert.equal(device.obj.common.name, 'Ünïcode "Tracker" 1');
});
