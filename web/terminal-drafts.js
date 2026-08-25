export const TERMINAL_DRAFT_STORAGE_KEY = 'webspider_terminal_drafts_v1';
const MAX_TERMINAL_DRAFTS = 100;

function storageTarget(storage) {
  if (storage) return storage;
  try { return globalThis.sessionStorage; } catch { return null; }
}

export function loadTerminalDrafts(storage = null) {
  try {
    const parsed = JSON.parse(storageTarget(storage)?.getItem(TERMINAL_DRAFT_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed)
      .filter(([terminalId, text]) => terminalId && typeof text === 'string')
      .slice(-MAX_TERMINAL_DRAFTS));
  } catch {
    return {};
  }
}

export function terminalDraft(drafts, terminalId) {
  return typeof drafts?.[terminalId] === 'string' ? drafts[terminalId] : '';
}

export function saveTerminalDraft(drafts, terminalId, text, storage = null) {
  if (!drafts || !terminalId) return;
  delete drafts[terminalId];
  if (text) drafts[terminalId] = String(text);
  while (Object.keys(drafts).length > MAX_TERMINAL_DRAFTS) delete drafts[Object.keys(drafts)[0]];
  try {
    const target = storageTarget(storage);
    if (!target) return;
    if (Object.keys(drafts).length) target.setItem(TERMINAL_DRAFT_STORAGE_KEY, JSON.stringify(drafts));
    else target.removeItem(TERMINAL_DRAFT_STORAGE_KEY);
  } catch { /* the in-memory draft still survives in-app navigation */ }
}

export function clearTerminalDraft(drafts, terminalId, storage = null) {
  saveTerminalDraft(drafts, terminalId, '', storage);
}
