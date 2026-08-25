export async function hubSynchronizedTimestamp(hubURL, fetchImpl = fetch) {
  const response = await fetchImpl(new URL('/healthz', hubURL));
  if (!response.ok) throw new Error(`Could not synchronize with the hub clock: HTTP ${response.status}`);
  const health = await response.json();
  const timestamp = Date.parse(health.time);
  if (!Number.isFinite(timestamp)) throw new Error('Could not synchronize with the hub clock: invalid health timestamp');
  return timestamp;
}

export async function hubClockOffset(hubURL, fetchImpl = fetch, now = Date.now) {
  const startedAt = now();
  const hubTimestamp = await hubSynchronizedTimestamp(hubURL, fetchImpl);
  const finishedAt = now();
  return hubTimestamp - Math.round((startedAt + finishedAt) / 2);
}
