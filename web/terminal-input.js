export function kittySequence(codePoint, modifiers = 1) {
  return `\u001b[${codePoint}${modifiers === 1 ? '' : `;${modifiers}`}u`;
}

// Printable physical-key input does not need xterm's hidden textarea. Capturing it at
// keydown avoids browser/IME focus transitions silently swallowing fast ordinary typing.
// Composition, dead keys, navigation keys, and non-Kitty shortcuts remain xterm-owned.
export function directKeyInput(event, keyboardProtocol = false) {
  if (event?.type !== 'keydown') return null;
  const key = String(event.key || '');
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
