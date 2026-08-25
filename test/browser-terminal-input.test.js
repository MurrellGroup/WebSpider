import test from 'node:test';
import assert from 'node:assert/strict';
import { directKeyInput, enqueueTerminalData, kittySequence } from '../web/terminal-input.js';

test('rapid printable keydowns bypass the hidden terminal textarea without losing characters', () => {
  const expected = Array.from({ length: 2_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('');
  const received = [...expected].map((key) => directKeyInput({ type: 'keydown', key }, true)).join('');
  assert.equal(received, expected);
  assert.equal(directKeyInput({ type: 'keydown', key: 'Å', shiftKey: true }, true), 'Å');
  assert.equal(directKeyInput({ type: 'keydown', key: 'Dead' }, true), null);
  assert.equal(directKeyInput({ type: 'keydown', key: 'a', isComposing: true }, true), null);
  assert.equal(directKeyInput({ type: 'keydown', key: 'Enter' }, true), null);
  assert.equal(directKeyInput({ type: 'keyup', key: 'a' }, true), null);
});

test('modified Kitty keys remain encoded while ordinary shortcuts stay xterm-owned', () => {
  assert.equal(directKeyInput({ type: 'keydown', key: 'c', ctrlKey: true }, true), kittySequence(99, 5));
  assert.equal(directKeyInput({ type: 'keydown', key: 'c', ctrlKey: true }, false), null);
  assert.equal(directKeyInput({ type: 'keydown', key: 'x', altKey: true, shiftKey: true }, true), kittySequence(120, 4));
});

test('terminal data always queues and requests control when no precursor event did so', () => {
  const events = [];
  assert.equal(enqueueTerminalData('abc', {
    controlled: false,
    requestPending: false,
    requestControl: () => events.push('request'),
    enqueue: (data) => events.push(`data:${data}`),
  }), true);
  assert.deepEqual(events, ['request', 'data:abc']);

  events.length = 0;
  enqueueTerminalData('def', {
    controlled: false,
    requestPending: true,
    requestControl: () => events.push('request'),
    enqueue: (data) => events.push(`data:${data}`),
  });
  assert.deepEqual(events, ['data:def']);
  assert.equal(enqueueTerminalData('', { enqueue: () => events.push('unexpected') }), false);
});
