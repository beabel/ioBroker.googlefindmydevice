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
    this.states = new Map();
    this.foreignObjects = new Map();
    this.timers = [];
    this.sent = [];
  }
  on() {}
  subscribeStates() {}
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
  async getStateAsync(id) {
    return this.states.get(id) || null;
  }
  async getForeignObjectAsync(id) {
    return this.foreignObjects.get(id) || null;
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
const soundCalls = [];
let soundError = null;
const lib = name => require.resolve(path.join(__dirname, '..', 'lib', name));
const fake = (resolved, exports) => {
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
fake(require.resolve('@iobroker/adapter-core'), { Adapter: FakeAdapter });
let exchangeResult = {};
let exchangeError = null;
const exchangeCalls = [];
fake(lib('google-auth.js'), {
  performOAuth: async () => ({ Auth: 'token' }),
  exchangeToken: async (email, token) => {
    exchangeCalls.push(token);
    if (exchangeError) {
      throw exchangeError;
    }
    return exchangeResult;
  },
  DEFAULT_CLIENT_SIG: 'sig',
});
fake(lib('google-checkin.js'), { gcmCheckin: async () => ({ androidId: '111', securityToken: '222' }) });
fake(lib('nova-api.js'), {
  listDevices: async () => trackers,
  executeLocateAction: async () => {},
  executeSoundAction: async (token, params, start) => {
    if (soundError) {
      throw soundError;
    }
    soundCalls.push({ requestUuid: params.requestUuid, start });
  },
});
// Real parsing and script/URL helpers, but no network call for the owner key itself.
const realOwnerKey = require('../lib/owner-key');
fake(lib('owner-key.js'), {
  ...realOwnerKey,
  retrieveOwnerKey: async () => ({ ownerKey: Buffer.from('0a0b', 'hex'), ownerKeyVersion: 3 }),
});

const createAdapter = require('../main.js');
const { DEVICE_STATES } = require('../lib/objects');

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
  assert.equal(created.length, DEVICE_STATES.length + 1, 'the device plus all its states; the phone creates nothing');

  await adapter.updateDevices();
  await adapter.updateDevices();
  assert.equal(
    callsOf(adapter, 'extendObject').length,
    DEVICE_STATES.length + 1,
    'objects are not rewritten on every poll',
  );
});

test('values are written with setStateChanged under the new ids', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];

  await adapter.updateDevices();
  const written = Object.fromEntries(callsOf(adapter, 'setStateChanged').map(call => [call[1], call[2].val]));

  assert.equal(written['AAA-111.name'], 'Bike');
  assert.equal(written['AAA-111.manufacturer'], 'Maker');
  assert.equal(written['AAA-111.pairDate'], 1_700_000_000_000);
  const unconditional = callsOf(adapter, 'setState').map(call => call[1]);
  assert.deepEqual(unconditional, ['AAA-111.tracking'], 'only the tracking switch gets an initial value');
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

const ask = async (adapter, command, message) => {
  adapter.sent.length = 0;
  await adapter.onMessage({ command, message, from: 'system.adapter.admin.0', callback: { id: 9 } });
  return adapter.sent[0].result;
};

test('Connect button: exchanges the pasted token and hands the account back to the page', async () => {
  const adapter = createAdapter();
  exchangeCalls.length = 0;
  exchangeResult = { Token: 'aas-token', Email: 'me@example.org' };

  const result = await ask(adapter, 'connectAccount', { token: '  pasted-token  ' });

  assert.deepEqual(exchangeCalls, ['pasted-token'], 'the token is trimmed');
  assert.deepEqual(result.native, {
    oauthToken: '',
    email: 'me@example.org',
    androidId: '111',
    securityToken: '222',
    aasToken: 'aas-token',
  });
  assert.equal(result.saveConfig, true);
});

test('Connect button: an empty or rejected token produces a readable error, nothing is stored', async () => {
  const adapter = createAdapter();
  exchangeResult = { Token: 'x', Email: 'y' };
  assert.match((await ask(adapter, 'connectAccount', { token: '   ' })).error, /paste the oauth_token/);
  assert.match((await ask(adapter, 'connectAccount', {})).error, /paste the oauth_token/);

  exchangeResult = {};
  const rejected = await ask(adapter, 'connectAccount', { token: 'expired' });
  assert.match(rejected.error, /probably expired/);
  assert.equal(rejected.native, undefined);
});

test('Unlock button: derives the owner key from the values the page sends, before anything is saved', async () => {
  const adapter = createAdapter();
  const account = { email: 'me@example.org', aasToken: 'aas', androidId: '111' };
  const pasted = JSON.stringify({ finder_hw: [{ key: { 0: 1, 1: 2 } }] });

  const result = await ask(adapter, 'unlockEncryption', { json: pasted, ...account });

  assert.deepEqual(result.native, { sharedKeyJson: '', ownerKey: '0a0b', ownerKeyVersion: 3 });
  assert.equal(result.saveConfig, true);
});

test('Unlock button: explains what is missing or wrong instead of failing silently', async () => {
  const adapter = createAdapter();
  const account = { email: 'me@example.org', aasToken: 'aas', androidId: '111' };

  assert.match((await ask(adapter, 'unlockEncryption', { json: '', ...account })).error, /paste the result/);
  assert.match((await ask(adapter, 'unlockEncryption', { json: '{}' })).error, /Part 1 of the setup first/);
  assert.match((await ask(adapter, 'unlockEncryption', { json: 'not json', ...account })).error, /not valid JSON/);
  assert.match((await ask(adapter, 'unlockEncryption', { json: '{}', ...account })).error, /No "finder_hw" key/);
});

test('Reconnect button: clears the login, the key and the tracker table, then asks to save', async () => {
  const adapter = createAdapter();
  const result = await ask(adapter, 'resetLogin', {});

  assert.equal(result.saveConfig, true);
  assert.deepEqual(result.native, {
    oauthToken: '',
    email: '',
    androidId: '',
    securityToken: '',
    aasToken: '',
    sharedKeyJson: '',
    ownerKey: '',
    ownerKeyVersion: -1,
    deviceSettings: [],
  });
});

test('Connect button: a rejected token ("BadAuthentication") is explained in plain words', async () => {
  const adapter = createAdapter();
  exchangeError = new Error('Google auth error: BadAuthentication');
  try {
    const result = await ask(adapter, 'connectAccount', { token: 'whatever' });
    assert.match(result.error, /rejected the oauth_token.*expired/);
  } finally {
    exchangeError = null;
  }
});

test('a button press runs the matching action and is acknowledged afterwards', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  const ran = [];
  adapter.triggerLocate = async (id, name) => ran.push(['locate', id, name]);
  adapter.triggerSound = async (id, name, start) => ran.push([start ? 'play' : 'stop', id, name]);

  for (const button of ['locateNow', 'playSound', 'stopSound']) {
    await adapter.onStateChange(`googlefindmydevice.0.AAA-111.${button}`, { val: true, ack: false });
  }

  assert.deepEqual(ran, [
    ['locate', 'AAA-111', 'Bike'],
    ['play', 'AAA-111', 'Bike'],
    ['stop', 'AAA-111', 'Bike'],
  ]);
  const acks = callsOf(adapter, 'setState').filter(call => call[2].ack === true && !call[1].endsWith('.tracking'));
  assert.equal(acks.length, 3, 'every press is acknowledged');
});

test('acknowledged changes, false values and unrelated states do not trigger anything', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  let ran = 0;
  adapter.triggerLocate = async () => ran++;
  adapter.triggerSound = async () => ran++;

  await adapter.onStateChange('googlefindmydevice.0.AAA-111.locateNow', { val: true, ack: true });
  await adapter.onStateChange('googlefindmydevice.0.AAA-111.locateNow', { val: false, ack: false });
  await adapter.onStateChange('googlefindmydevice.0.AAA-111.latitude', { val: 5, ack: false });
  await adapter.onStateChange('googlefindmydevice.0.AAA-111.locateNow', null);
  await adapter.onStateChange('googlefindmydevice.0.UNKNOWN.locateNow', { val: true, ack: false });

  assert.equal(ran, 0);
});

test('a failing button action is logged and the button is still acknowledged', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  const warnings = [];
  adapter.log.warn = message => warnings.push(message);
  adapter.triggerSound = async () => {
    throw new Error('HTTP 500');
  };

  await adapter.onStateChange('googlefindmydevice.0.AAA-111.playSound', { val: true, ack: false });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 500/);
  assert.equal(
    callsOf(adapter, 'setState').filter(call => call[2].ack === true && !call[1].endsWith('.tracking')).length,
    1,
  );
});

test('only one location request per tracker runs at a time', async () => {
  const adapter = createAdapter();
  let started = 0;
  let release;
  adapter.requestLocation = () => {
    started++;
    return new Promise(resolve => (release = resolve));
  };

  const first = adapter.triggerLocate('AAA-111', 'Bike');
  await adapter.triggerLocate('AAA-111', 'Bike'); // skipped
  assert.equal(started, 1);
  release();
  await first;
  const third = adapter.triggerLocate('AAA-111', 'Bike'); // free again
  assert.equal(started, 2);
  release();
  await third;
});

function soundAdapter() {
  const adapter = createAdapter();
  adapter.ensureFcmReady = async () => {};
  adapter.fcmIdentity = { fcmToken: 'fcm' };
  adapter.fmdClientUuid = 'client';
  soundCalls.length = 0;
  return adapter;
}
const ageSoundKeys = (adapter, ms) => adapter.soundKeys.get('AAA-111').forEach(key => (key.at -= ms));

test('every sound start is remembered and a stop cancels all of them, as often as needed', async () => {
  const adapter = soundAdapter();
  await adapter.triggerSound('AAA-111', 'Bike', true);
  await adapter.triggerSound('AAA-111', 'Bike', true);
  const [first, second] = soundCalls.map(call => call.requestUuid);
  assert.notEqual(first, second);
  ageSoundKeys(adapter, 20000);

  await adapter.triggerSound('AAA-111', 'Bike', false);
  const stops = soundCalls.filter(call => !call.start).map(call => call.requestUuid);
  assert.deepEqual(stops, [first, second], 'one stop per start, with the request id of that start');

  soundCalls.length = 0;
  await adapter.triggerSound('AAA-111', 'Bike', false);
  assert.deepEqual(
    soundCalls.map(call => call.requestUuid),
    [first, second],
    'the keys stay, so a second stop still carries them',
  );
});

test('a stop without a known start is sent without a request id', async () => {
  const adapter = soundAdapter();
  await adapter.triggerSound('AAA-111', 'Bike', false);
  assert.deepEqual(soundCalls, [{ requestUuid: '', start: false }]);
});

test('a stop right after the start waits, so it cannot silence the tracker', async () => {
  const adapter = soundAdapter();
  await adapter.triggerSound('AAA-111', 'Bike', true);
  const started = soundCalls.length;

  const stop = adapter.triggerSound('AAA-111', 'Bike', false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(soundCalls.length, started, 'the stop has not been sent yet');
  assert.equal(adapter.timers.length, 1);
  assert.ok(adapter.timers[0].ms > 0 && adapter.timers[0].ms <= 12000, 'it waits for the rest of the 12 seconds');

  adapter.timers[0].fn();
  await stop;
  assert.equal(soundCalls.length, started + 1);
  assert.equal(soundCalls.at(-1).start, false);
});

test('a location request without an answer is repeated once after a pause', async () => {
  const adapter = createAdapter();
  const attempts = [];
  adapter.requestLocation = async () => {
    attempts.push(attempts.length);
    if (attempts.length === 1) {
      throw Object.assign(new Error('Timed out waiting for the location push message.'), { code: 'LOCATE_TIMEOUT' });
    }
  };

  const done = adapter.triggerLocate('AAA-111', 'Bike');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts.length, 1, 'the retry waits for its pause');
  assert.equal(adapter.timers.length, 1);
  adapter.timers[0].fn();
  await done;

  assert.equal(attempts.length, 2);
  assert.equal(adapter.locating.size, 0, 'the tracker is free again');
});

test('only a timeout is retried, and only once', async () => {
  const adapter = createAdapter();
  let attempts = 0;
  adapter.requestLocation = async () => {
    attempts++;
    throw new Error('HTTP 500');
  };
  await assert.rejects(adapter.triggerLocate('AAA-111', 'Bike'), /HTTP 500/);
  assert.equal(attempts, 1, 'an error other than a timeout is not retried');

  attempts = 0;
  adapter.timers.length = 0;
  adapter.requestLocation = async () => {
    attempts++;
    throw Object.assign(new Error('Timed out waiting for the location push message.'), { code: 'LOCATE_TIMEOUT' });
  };
  const done = assert.rejects(adapter.triggerLocate('AAA-111', 'Bike'), /Timed out/);
  await new Promise(resolve => setImmediate(resolve));
  adapter.timers[0].fn();
  await done;
  assert.equal(attempts, 2, 'a second timeout is reported instead of retried again');
  assert.equal(adapter.locating.size, 0);
});

test('a sound request that Google rejects with HTTP 500 is explained', async () => {
  const adapter = createAdapter();
  adapter.ensureFcmReady = async () => {};
  adapter.fcmIdentity = { fcmToken: 'fcm' };
  adapter.fmdClientUuid = 'client';
  soundError = new Error('Nova ExecuteAction failed: HTTP 500 - <HTML>');
  try {
    await assert.rejects(adapter.triggerSound('AAA-111', 'Speaker', true), /probably cannot play a sound/);
  } finally {
    soundError = null;
  }
});

test('the tracking switch is acknowledged, and a paused tracker is skipped by the schedule', async () => {
  const adapter = createAdapter();
  trackers = [tracker('AAA-111', 'Bike')];
  await adapter.updateDevices();
  assert.ok(callsOf(adapter, 'setState').some(call => call[1] === 'AAA-111.tracking' && call[2].val === true));

  await adapter.onStateChange('googlefindmydevice.0.AAA-111.tracking', { val: false, ack: false });
  const acks = callsOf(adapter, 'setState').filter(call => call[1].endsWith('.tracking') && call[2].ack === true);
  assert.equal(acks.at(-1)[2].val, false);

  adapter.config.deviceSettings = [{ canonicId: 'AAA-111', name: 'Bike', locate: true, intervalMinutes: 60 }];
  adapter.states.set('AAA-111.tracking', { val: false });
  let located = 0;
  adapter.triggerLocate = async () => located++;
  adapter.timers.length = 0;
  adapter.startLocateTimers();
  await adapter.timers[0].fn();
  assert.equal(located, 0, 'no automatic request while the switch is off');
  assert.equal(adapter.timers.length, 2, 'the next round is scheduled anyway');

  adapter.states.set('AAA-111.tracking', { val: true });
  await adapter.timers[1].fn();
  assert.equal(located, 1, 'requests resume when the switch is on again');
});

test('the home place gets the position from the ioBroker system settings, other places stay empty', async () => {
  const adapter = createAdapter();
  const written = [];
  adapter.extendForeignObject = async (id, obj) => written.push(obj.native.semanticLocations);
  adapter.foreignObjects.set('system.config', { common: { latitude: '50.83', longitude: '12.74' } });

  await adapter.registerSemanticName('Home');
  await adapter.registerSemanticName('Office');

  assert.deepEqual(written[0], [{ name: 'Home', latitude: 50.83, longitude: 12.74, radius: 100 }]);
  assert.deepEqual(written[1], [{ name: 'Office', latitude: null, longitude: null, radius: 100 }]);
});

test('without a position in the system settings the home place is added empty', async () => {
  const adapter = createAdapter();
  const written = [];
  adapter.extendForeignObject = async (id, obj) => written.push(obj.native.semanticLocations);
  await adapter.registerSemanticName('Home');
  assert.deepEqual(written[0], [{ name: 'Home', latitude: null, longitude: null, radius: 100 }]);
});

test('an unmatched push is logged with the tracker of the sound request it answers', () => {
  const adapter = createAdapter();
  const lines = [];
  adapter.log.debug = message => lines.push(message);
  adapter.trackers.set('AAA-111', { canonicId: 'canon-1', name: 'Bike' });
  adapter.soundKeys.set('canon-1', [{ uuid: 'req-1', at: Date.now() }]);

  adapter.onUnmatchedPush({ requestUuid: 'req-1', structure: '1{2:len36}' });
  adapter.onUnmatchedPush({ requestUuid: 'other', structure: '9=1' });

  assert.match(lines[0], /sound request for "Bike": 1\{2:len36\}/);
  assert.match(lines[1], /unknown or expired request ignored: 9=1/);
});
