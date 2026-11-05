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
  const pending = client.waitForDeviceUpdates('request-1', 45000);
  assert.equal(scheduled.size, 1);

  for (const fire of scheduled.values()) {
    fire();
  }
  await assert.rejects(pending, /Timed out waiting for the location push message/);
});

test('stopping the client rejects pending requests and cancels their timers', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdates('request-2', 45000);
  assert.equal(scheduled.size, 1);

  client.stop();

  await assert.rejects(pending, /MCS connection was closed/);
  assert.equal(scheduled.size, 0, 'the request timeout must be cancelled');
});

test('error messages are English (they end up in the adapter log)', async () => {
  const { client } = createClient();
  const pending = client.waitForDeviceUpdates('request-3', 1);
  client.stop();
  await assert.rejects(pending, err => /^[\x20-\x7E]+$/.test(err.message));
});

test('a client that was never started is not logged in', () => {
  const { client } = createClient();
  assert.equal(client.isLoggedIn(), false);
});

test('received message ids are remembered, deduplicated and capped, and reported on change', () => {
  const { client } = createClient();
  const seen = [];
  client.setReceivedIds(['old-1', '', 5, 'old-2'], list => seen.push(list));
  assert.deepEqual(client._receivedIds, ['old-1', 'old-2']);

  client._rememberReceivedId('new-1');
  client._rememberReceivedId('new-1');
  assert.equal(seen.length, 1, 'a known id must not trigger another save');
  assert.deepEqual(seen[0], ['old-1', 'old-2', 'new-1']);

  for (let i = 0; i < 150; i++) {
    client._rememberReceivedId(`id-${i}`);
  }
  assert.equal(client._receivedIds.length, 100);
  assert.equal(client._receivedIds.at(-1), 'id-149');
});

test('a list that is not an array is ignored instead of throwing', () => {
  const { client } = createClient();
  client.setReceivedIds('garbage');
  assert.deepEqual(client._receivedIds, []);
});

test('without a grace period the first answer completes the request', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdates('request-4', 45000);
  client._collectUpdate('request-4', { n: 1 });

  assert.deepEqual(await pending, [{ n: 1 }]);
  assert.equal(scheduled.size, 0, 'the request timeout must be cancelled');
  assert.equal(client._pending.size, 0);
});

test('with a grace period further answers are collected until it ends', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdates('request-5', 45000, 25000);
  client._collectUpdate('request-5', { n: 1 });
  assert.equal(scheduled.size, 1, 'only the grace timer is left, the first-answer timeout is cancelled');
  client._collectUpdate('request-5', { n: 2 });
  client._collectUpdate('request-5', { n: 3 });
  assert.equal(client._pending.size, 1, 'still open while the grace period runs');

  for (const fire of scheduled.values()) {
    fire();
  }
  assert.deepEqual(await pending, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(client._pending.size, 0);
});

test('stopping the client during the grace period keeps the answers that already arrived', async () => {
  const { client, scheduled } = createClient();
  const pending = client.waitForDeviceUpdates('request-6', 45000, 25000);
  client._collectUpdate('request-6', { n: 1 });

  client.stop();

  assert.deepEqual(await pending, [{ n: 1 }]);
  assert.equal(scheduled.size, 0, 'the grace timer must be cancelled');
});
