export function reconcileTerminalOutput(currentSequence, frame, bytes) {
  const current = Number(currentSequence);
  const start = Number(frame?.sequence_start);
  const end = Number(frame?.sequence_end);
  if (![current, start, end].every(Number.isSafeInteger) || current < 0 || start < 0 || end < start) {
    return { kind: 'invalid' };
  }
  if (!(bytes instanceof Uint8Array) || bytes.length !== end - start) return { kind: 'invalid' };
  if (end <= current) return { kind: 'stale', sequence: current };
  if (start > current) return { kind: 'gap', expected: current, received: start };
  const overlap = current - start;
  return { kind: 'append', sequence: end, bytes: overlap ? bytes.slice(overlap) : bytes };
}

export function orderTerminalOutputFrames(frames) {
  return [...frames].sort((left, right) => (
    Number(left?.sequence_start) - Number(right?.sequence_start)
      || Number(left?.sequence_end) - Number(right?.sequence_end)
  ));
}
