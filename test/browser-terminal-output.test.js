import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTerminalOutputFrames, reconcileTerminalOutput } from '../web/terminal-output.js';

test('terminal output never advances across a missing byte range', () => {
  const current = 100;
  const gap = reconcileTerminalOutput(current, { sequence_start: 101, sequence_end: 102 }, Uint8Array.of(98));
  assert.deepEqual(gap, { kind: 'gap', expected: 100, received: 101 });

  const append = reconcileTerminalOutput(current, { sequence_start: 99, sequence_end: 102 }, Uint8Array.of(97, 98, 99));
  assert.equal(append.kind, 'append');
  assert.equal(append.sequence, 102);
  assert.deepEqual([...append.bytes], [98, 99]);
});

test('terminal output rejects malformed ranges and orders recovery frames', () => {
  assert.deepEqual(reconcileTerminalOutput(0, { sequence_start: 0, sequence_end: 2 }, Uint8Array.of(1)), { kind: 'invalid' });
  assert.deepEqual(reconcileTerminalOutput(5, { sequence_start: 1, sequence_end: 5 }, Uint8Array.of(1, 2, 3, 4)), { kind: 'stale', sequence: 5 });
  assert.deepEqual(orderTerminalOutputFrames([
    { sequence_start: 8, sequence_end: 9 },
    { sequence_start: 3, sequence_end: 5 },
    { sequence_start: 3, sequence_end: 4 },
  ]).map((frame) => frame.sequence_end), [4, 5, 9]);
});
