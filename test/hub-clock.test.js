import test from 'node:test';
import assert from 'node:assert/strict';
import { hubClockOffset, hubSynchronizedTimestamp } from '../src/lib/hub-clock.js';

test('hub clock synchronization reads the health timestamp', async () => {
  let requestedURL;
  const timestamp = await hubSynchronizedTimestamp('http://100.64.0.1:7340', async (url) => {
    requestedURL = url.href;
    return {
      ok: true,
      async json() { return { status: 'ok', time: '2026-08-25T08:09:10.123Z' }; },
    };
  });

  assert.equal(requestedURL, 'http://100.64.0.1:7340/healthz');
  assert.equal(timestamp, Date.parse('2026-08-25T08:09:10.123Z'));
});

test('hub clock offset accounts for request transit time', async () => {
  const times = [1_000, 1_200];
  const offset = await hubClockOffset('http://100.64.0.1:7340', async () => ({
    ok: true,
    async json() { return { time: new Date(2_100).toISOString() }; },
  }), () => times.shift());

  assert.equal(offset, 1_000);
});

test('hub clock synchronization rejects an invalid health timestamp', async () => {
  await assert.rejects(
    () => hubSynchronizedTimestamp('http://100.64.0.1:7340', async () => ({
      ok: true,
      async json() { return { status: 'ok', time: 'not-a-time' }; },
    })),
    /invalid health timestamp/,
  );
});
