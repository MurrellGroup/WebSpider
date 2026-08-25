export function kittySequence(codePoint, modifiers = 1) {
  return `\u001b[${codePoint}${modifiers === 1 ? '' : `;${modifiers}`}u`;
}

export function clipboardPasteShortcut(event) {
  if (event?.type !== 'keydown' || String(event.key || '').toLowerCase() !== 'v' || event.altKey) return false;
  return Boolean(event.metaKey) !== Boolean(event.ctrlKey) && (event.metaKey || event.ctrlKey);
}

export function terminalAttachmentCommitKey(event, hasPendingAttachments = false) {
  return Boolean(hasPendingAttachments) && event?.type === 'keydown' && event.key === 'Enter'
    && !event.shiftKey && !event.isComposing;
}

// Printable physical-key input does not need xterm's hidden textarea. Capturing it at
// keydown avoids browser/IME focus transitions silently swallowing fast ordinary typing.
// Composition, dead keys, navigation keys, and non-Kitty shortcuts remain xterm-owned.
export function directKeyInput(event, keyboardProtocol = false) {
  if (event?.type !== 'keydown') return null;
  // Preserve the browser paste gesture even when the child process enables the
  // Kitty keyboard protocol. Encoding Cmd/Ctrl+V here prevents ClipboardEvent
  // from firing, so clipboard images can only be pasted from the context menu.
  if (clipboardPasteShortcut(event)) return null;
  const key = String(event.key || '');
  if (keyboardProtocol && key === 'Enter' && event.shiftKey
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
