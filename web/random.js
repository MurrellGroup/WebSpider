export function randomIdentifier(cryptoProvider = globalThis.crypto) {
  const bytes = new Uint8Array(16);
  if (typeof cryptoProvider?.getRandomValues === 'function') {
    cryptoProvider.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}
