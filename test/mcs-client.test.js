'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { McsClient } = require('../lib/mcs-client');

// The client must only ever use the timers it is handed (never the Node
// globals), so a fake timer set is enough to drive it deterministically.
function createClient() {
  const scheduled = new Map();
  let nextId = 1;
  const timers = {
    setTimeout: fn => {
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    clearTimeout: id => scheduled.delete(id),
    setInterval: () => nextId++,
    clearInterval: () => {},
  };
  const noop = () => {};
  const client = new McsClient({ log: { debug: noop, info: noop, warn: noop, error: noop }, timers });
  return { client, scheduled };
}

test('a locate request that gets no answer is rejected with a clear message', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdate('request-1', 45000);
  assert.equal(scheduled.size, 1);

  for (const fire of scheduled.values()) {
    fire();
  }
  await assert.rejects(pending, /Timed out waiting for the location push message/);
});

test('stopping the client rejects pending requests and cancels their timers', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdate('request-2', 45000);
  assert.equal(scheduled.size, 1);

  client.stop();

  await assert.rejects(pending, /MCS connection was closed/);
  assert.equal(scheduled.size, 0, 'the request timeout must be cancelled');
});

test('error messages are English (they end up in the adapter log)', async () => {
  const { client } = createClient();
  const pending = client.waitForDeviceUpdate('request-3', 1);
  client.stop();
  await assert.rejects(pending, err => /^[\x20-\x7E]+$/.test(err.message));
});

test('a client that was never started is not logged in', () => {
  const { client } = createClient();
  assert.equal(client.isLoggedIn(), false);
});
