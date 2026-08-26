export function kittySequence(codePoint, modifiers = 1) {
  return `\u001b[${codePoint}${modifiers === 1 ? '' : `;${modifiers}`}u`;
}

export function clipboardPasteShortcut(event) {
  if (event?.type !== 'keydown' || String(event.key || '').toLowerCase() !== 'v' || event.altKey) return false;
  return Boolean(event.metaKey) !== Boolean(event.ctrlKey) && (event.metaKey || event.ctrlKey);
}

export function clipboardCopyShortcut(event, hasSelection = false) {
  if (!hasSelection || event?.type !== 'keydown'
    || String(event.key || '').toLowerCase() !== 'c' || event.altKey) return false;
  return Boolean(event.metaKey) !== Boolean(event.ctrlKey) && (event.metaKey || event.ctrlKey);
}

export function createTerminalKeyState() {
  return { shiftDown: false, shiftedEnterDown: false };
}

function shiftIsActive(event, keyState) {
  let modifierState = false;
  try { modifierState = Boolean(event?.getModifierState?.('Shift')); } catch { /* synthetic or incomplete event */ }
  return Boolean(event?.shiftKey || modifierState || keyState?.shiftDown || keyState?.shiftedEnterDown);
}

export function trackTerminalKey(event, keyState) {
  if (!keyState || !event) return keyState;
  if (event.key === 'Shift') keyState.shiftDown = event.type === 'keydown';
  if (event.key === 'Enter' && event.type === 'keydown' && shiftIsActive(event, keyState)) {
    keyState.shiftedEnterDown = true;
  }
  if (event.key === 'Enter' && event.type === 'keyup') keyState.shiftedEnterDown = false;
  return keyState;
}

export function resetTerminalKeyState(keyState) {
  if (keyState) {
    keyState.shiftDown = false;
    keyState.shiftedEnterDown = false;
  }
}

export function terminalComposeEnterAction(event, keyState) {
  if (event?.type !== 'keydown' || event.key !== 'Enter') return null;
  if (event.isComposing) return 'native';
  if (shiftIsActive(event, keyState)) return 'newline';
  // One physical Enter press must never submit more than once if the browser
  // emits repeat keydowns while an asynchronous send is still in flight.
  if (event.repeat) return 'ignore';
  return 'submit';
}

export function terminalAttachmentCommitKey(event, hasPendingAttachments = false, keyState = null) {
  return Boolean(hasPendingAttachments) && event?.type === 'keydown' && event.key === 'Enter'
    && !shiftIsActive(event, keyState) && !event.repeat && !event.isComposing;
}

// Printable physical-key input does not need xterm's hidden textarea. Capturing it at
// keydown avoids browser/IME focus transitions silently swallowing fast ordinary typing.
// Composition, dead keys, navigation keys, and non-Kitty shortcuts remain xterm-owned.
export function directKeyInput(event, keyboardProtocol = false, keyState = null) {
  if (event?.type !== 'keydown') return null;
  // Preserve the browser paste gesture even when the child process enables the
  // Kitty keyboard protocol. Encoding Cmd/Ctrl+V here prevents ClipboardEvent
  // from firing, so clipboard images can only be pasted from the context menu.
  if (clipboardPasteShortcut(event)) return null;
  const key = String(event.key || '');
  if (keyboardProtocol && key === 'Enter' && shiftIsActive(event, keyState)
    && !event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return kittySequence(13, 2);
  }
  if (!event.isComposing && !event.ctrlKey && !event.altKey && !event.metaKey && [...key].length === 1) return key;
  if (!keyboardProtocol || !(event.ctrlKey || event.altKey || event.metaKey) || [...key].length !== 1) return null;
  const modifiers = 1
    + (event.shiftKey ? 1 : 0)
    + (event.altKey ? 2 : 0)
    + (event.ctrlKey ? 4 : 0)
    + (event.metaKey ? 8 : 0);
  return kittySequence(key.codePointAt(0), modifiers);
}

export function enqueueTerminalData(data, {
  controlled = false,
  requestPending = false,
  requestControl,
  enqueue,
} = {}) {
  if (!data) return false;
  if (!controlled && !requestPending) requestControl?.();
  enqueue?.(data);
  return true;
}
