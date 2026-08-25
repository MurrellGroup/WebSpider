import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalInputPipeline } from '../src/hub/terminal-input-pipeline.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('slow terminal input is coalesced without dropping, duplicating, or reordering bytes', async () => {
  const deliveries = [];
  const gates = [];
  const acknowledgements = [];
  const pipeline = new TerminalInputPipeline({
    maxInFlight: 1,
    maxBatchBytes: 64 * 1024,
    sendBatch: (bytes) => {
      deliveries.push(Buffer.from(bytes));
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    acknowledge: (_result, frames, bytes) => acknowledgements.push({ frames, bytes }),
  });

  const chunks = Array.from({ length: 2_000 }, (_, index) => Buffer.from(`${String(index).padStart(4, '0')}|`));
  for (const [index, bytes] of chunks.entries()) pipeline.enqueue(bytes, { input_sequence: index + 1 });
  await settle();
  assert.equal(deliveries.length, 1);

  gates[0].resolve({ accepted_bytes: deliveries[0].length });
  await settle();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].length, Buffer.concat(chunks.slice(1)).length);
  gates[1].resolve({ accepted_bytes: deliveries[1].length });
  await settle();

  assert.deepEqual(Buffer.concat(deliveries), Buffer.concat(chunks));
  assert.equal(acknowledgements.reduce((sum, item) => sum + item.bytes, 0), Buffer.concat(chunks).length);
  assert.equal(acknowledgements.at(-1).frames.at(-1).input_sequence, chunks.length);
});

test('terminal input uses a bounded latency window and halts visibly on delivery failure', async () => {
  const deliveries = [];
  const gates = [];
  const failures = [];
  const pipeline = new TerminalInputPipeline({
    maxInFlight: 4,
    sendBatch: (bytes) => {
      deliveries.push(bytes.toString());
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    fail: (error) => failures.push(error.message),
  });

  for (let index = 0; index < 20; index += 1) pipeline.enqueue(Buffer.from(String.fromCharCode(65 + index)));
  await settle();
  assert.deepEqual(deliveries, ['A', 'B', 'C', 'D']);

  gates[0].resolve({ accepted_bytes: 1 });
  await settle();
  assert.equal(deliveries.join(''), 'ABCDEFGHIJKLMNOPQRST');
  gates[1].reject(new Error('simulated node failure'));
  await settle();
  assert.deepEqual(failures, ['simulated node failure']);
  assert.throws(() => pipeline.enqueue(Buffer.from('Z')), (error) => error.code === 'WS_TERMINAL_INPUT_UNCERTAIN');

  for (const gate of gates.slice(2)) gate.resolve({ accepted_bytes: 1 });
});
