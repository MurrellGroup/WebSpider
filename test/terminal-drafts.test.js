import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTerminalDraft, loadTerminalDrafts, saveTerminalDraft, terminalDraft,
  TERMINAL_DRAFT_STORAGE_KEY,
} from '../web/terminal-drafts.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('Text box drafts are isolated by terminal and survive page reconstruction', () => {
  const storage = memoryStorage();
  const drafts = loadTerminalDrafts(storage);
  saveTerminalDraft(drafts, 'trm_agent', 'message for the agent', storage);
  saveTerminalDraft(drafts, 'trm_shell', 'unfinished shell command', storage);

  const restored = loadTerminalDrafts(storage);
  assert.equal(terminalDraft(restored, 'trm_agent'), 'message for the agent');
  assert.equal(terminalDraft(restored, 'trm_shell'), 'unfinished shell command');
  assert.equal(terminalDraft(restored, 'trm_unknown'), '');

  clearTerminalDraft(restored, 'trm_agent', storage);
  assert.equal(terminalDraft(loadTerminalDrafts(storage), 'trm_agent'), '');
  assert.equal(terminalDraft(loadTerminalDrafts(storage), 'trm_shell'), 'unfinished shell command');
});

test('an unavailable browser store does not lose the in-memory draft', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota unavailable'); },
    removeItem: () => { throw new Error('quota unavailable'); },
  };
  const drafts = {};
  saveTerminalDraft(drafts, 'trm_agent', 'still here', storage);
  assert.equal(drafts.trm_agent, 'still here');
  assert.equal(TERMINAL_DRAFT_STORAGE_KEY, 'webspider_terminal_drafts_v1');
});
