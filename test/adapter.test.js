'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// main.js needs a real js-controller (requiring @iobroker/adapter-core outside
// one exits the process), so the adapter base class and the two modules that
// talk to Google are replaced by fakes before main.js is loaded. Everything
// else - object building, id handling, polling, cleanup - is the real code.

class FakeAdapter {
  constructor() {
    this.namespace = 'googlefindmydevice.0';
    this.config = { pollInterval: 15, email: 'a@b.c', aasToken: 't', androidId: '1', deviceSettings: [] };
    this.log = { debug() {}, info() {}, warn() {}, error() {} };
    this.calls = [];
    this.objects = new Map();
    this.timers = [];
    this.sent = [];
  }
  on() {}
  sendTo(to, command, result, callback) {
    this.sent.push({ to, command, result, callback });
  }
  async extendObject(id, obj) {
    this.calls.push(['extendObject', id, obj]);
  }
  async setState(id, state, ack) {
    this.calls.push(['setState', id, state, ack]);
  }
  async setStateChanged(id, state) {
    this.calls.push(['setStateChanged', id, state]);
  }
  async delObject(id, options) {
    this.calls.push(['delObject', id, options]);
  }
  async getObjectAsync(id) {
    return this.objects.get(id) || null;
  }
  async getAdapterObjectsAsync() {
    return Object.fromEntries(this.objects);
  }
  async extendForeignObject() {}
  setTimeout(fn, ms) {
    this.timers.push({ fn, ms });
    return this.timers.length;
  }
  clearTimeout() {}
  setInterval() {
    return 1;
  }
  clearInterval() {}
}

let trackers = [];
const lib = name => require.resolve(path.join(__dirname, '..', 'lib', name));
const fake = (resolved, exports) => {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
fake(require.resolve('@iobroker/adapter-core'), { Adapter: FakeAdapter });
fake(lib('google-auth.js'), {
  performOAuth: async () => ({ Auth: 'token' }),
  exchangeToken: async () => ({}),
  DEFAULT_CLIENT_SIG: 'sig',
});
fake(lib('nova-api.js'), { listDevices: async () => trackers, executeLocateAction: async () => {} });

const createAdapter = require('../main.js');

const tracker = (canonicId, name) => ({
  canonicId,
  name,
  manufacturer: 'Maker',
  model: 'Model',
  fastPairModelId: '1',
  deviceType: 'TRACKER',
  pairDate: 1_700_000_000,
  sharedWithCount: 0,
  raw: {},
});
const callsOf = (adapter, kind) => adapter.calls.filter(call => call[0] === kind);

test('creates each tracker as a device directly below the instance, once per run', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike'), { name: 'A phone, no canonicId' }];

  await adapter.updateDevices();
  const created = callsOf(adapter, 'extendObject');

  assert.equal(created[0][1], 'AAA-111', 'the device comes first');
  assert.equal(created[0][2].type, 'device');
  assert.equal(created[0][2].common.name, 'Bike');
  assert.ok(created.slice(1).every(call => call[1].startsWith('AAA-111.') && call[2].type === 'state'));
  assert.ok(!created.some(call => call[1].startsWith('devices')), 'no legacy "devices" folder');
  assert.equal(created.length, 16, 'device plus 15 states; the phone creates nothing');

  await adapter.updateDevices();
  await adapter.updateDevices();
  assert.equal(callsOf(adapter, 'extendObject').length, 16, 'objects are not rewritten on every poll');
});

test('values are written with setStateChanged under the new ids', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];

  await adapter.updateDevices();
  const written = Object.fromEntries(callsOf(adapter, 'setStateChanged').map(call => [call[1], call[2].val]));

  assert.equal(written['AAA-111.name'], 'Bike');
  assert.equal(written['AAA-111.manufacturer'], 'Maker');
  assert.equal(written['AAA-111.pairDate'], 1_700_000_000_000);
  assert.ok(callsOf(adapter, 'setState').length === 0, 'no unconditional writes');
});

test('renaming a tracker only updates its device name', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  adapter.calls.length = 0;

  trackers = [tracker('AAA-111', 'Bike lock')];
  await adapter.updateDevices();

  const created = callsOf(adapter, 'extendObject');
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].slice(1), ['AAA-111', { common: { name: 'Bike lock' } }]);
});

test('removes trackers that left the account, but never on an empty list', async () => {
  const adapter = createAdapter();
  adapter.objects.set('googlefindmydevice.0.info', { type: 'channel' });
  adapter.objects.set('googlefindmydevice.0.OLD-1', { type: 'device' });
  adapter.objects.set('googlefindmydevice.0.OLD-1.name', { type: 'state' });
  adapter.objects.set('googlefindmydevice.0.AAA-111', { type: 'device' });

  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  const deleted = callsOf(adapter, 'delObject');
  assert.deepEqual(
    deleted.map(call => call[1]),
    ['googlefindmydevice.0.OLD-1'],
    'only the stale device, not info or the current tracker',
  );
  assert.deepEqual(deleted[0][2], { recursive: true });

  adapter.calls.length = 0;
  adapter.objects.set('googlefindmydevice.0.OLD-2', { type: 'device' });
  trackers = [];
  await adapter.updateDevices();
  assert.equal(callsOf(adapter, 'delObject').length, 0, 'an empty list is treated as a hiccup, not "all gone"');
});

test('removes the legacy devices folder left by older versions', async () => {
  const adapter = createAdapter();
  await adapter.migrateLegacyDevicesTree();
  assert.equal(callsOf(adapter, 'delObject').length, 0, 'nothing to do on a fresh install');

  adapter.objects.set('devices', { type: 'folder' });
  await adapter.migrateLegacyDevicesTree();
  assert.deepEqual(callsOf(adapter, 'delObject')[0].slice(1), ['devices', { recursive: true }]);
});

test('polling schedules the next cycle, but never once the adapter is unloading', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];

  await adapter.pollLoop();
  assert.equal(adapter.timers.length, 1);
  assert.equal(adapter.timers[0].ms, 15 * 60 * 1000);

  adapter.onUnload(() => {});
  await adapter.pollLoop();
  assert.equal(adapter.timers.length, 1, 'no timer may be started after unload');
});

test('Step 2 button: "open" answers with the unlock page to open in a new tab', async () => {
  const adapter = createAdapter();
  await adapter.onMessage({ command: 'getStep2Url', from: 'system.adapter.admin.0', callback: { id: 1 } });

  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0].to, 'system.adapter.admin.0');
  assert.equal(adapter.sent[0].command, 'getStep2Url');
  assert.deepEqual(adapter.sent[0].callback, { id: 1 });
  assert.ok(
    adapter.sent[0].result.openUrl.startsWith('https://accounts.google.com/encryption/unlock/android?kdi='),
  );
  assert.equal(adapter.sent[0].result.window, '_blank');
});

test('Step 2 button: "script" answers with the console script for the copy dialog', async () => {
  const { CONSOLE_SNIPPET } = require('../lib/owner-key');
  const adapter = createAdapter();
  await adapter.onMessage({ command: 'getStep2Script', from: 'system.adapter.admin.0', callback: { id: 2 } });

  const { copyDialog } = adapter.sent[0].result;
  assert.equal(copyDialog.text, CONSOLE_SNIPPET);
  assert.equal(copyDialog.type, 'javascript');
  assert.ok(copyDialog.title);
});

test('messages for other commands, or without a callback, are ignored safely', async () => {
  const adapter = createAdapter();
  await adapter.onMessage({ command: 'somethingElse', from: 'x', callback: { id: 3 } });
  await adapter.onMessage({ command: 'getStep2Script', from: 'x' });
  await adapter.onMessage(null);
  await adapter.onMessage({});
  assert.equal(adapter.sent.length, 0);
});
