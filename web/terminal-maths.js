function looksLikeMath(source) {
  const value = String(source || '').trim();
  if (!value) return false;
  return /\\[A-Za-z]+|[_^{}]|[=<>]|(?:^|\s)[A-Za-z]\s*[+\-*/]\s*[A-Za-z0-9]|^[A-Za-z](?:_[A-Za-z0-9{}]+|\^[A-Za-z0-9{}]+)?$/.test(value);
}

function looksLikeBareDisplayMath(source) {
  const value = String(source || '').trim();
  return /\\[A-Za-z]+|(?:^|\s)[A-Za-z][A-Za-z0-9]*[_^](?:[A-Za-z0-9]|\{)/m.test(value);
}

function convertBareDisplayBlocks(source) {
  const lines = String(source || '').split('\n');
  for (let opening = 0; opening < lines.length; opening += 1) {
    if (!/^\s*\[\s*$/.test(lines[opening])) continue;
    let closing = opening + 1;
    while (closing < lines.length && !/^\s*\]\s*$/.test(lines[closing])) closing += 1;
    if (closing >= lines.length) continue;
    const body = lines.slice(opening + 1, closing).join('\n');
    if (!looksLikeBareDisplayMath(body)) continue;
    const indentation = lines[opening].match(/^\s*/)?.[0] || '';
    lines[opening] = `${indentation}\\[`;
    lines[closing] = `${indentation}\\]`;
    opening = closing;
  }
  return lines.join('\n');
}

function convertDollarMath(source) {
  const displays = String(source || '').replace(/\$\$([\s\S]*?)\$\$/g, (match, body) => (
    looksLikeMath(body) ? `\\[${body}\\]` : match
  ));
  return displays.split('\n').map((line) => {
    let output = '';
    let cursor = 0;
    while (cursor < line.length) {
      const opening = line.indexOf('$', cursor);
      if (opening < 0) {
        output += line.slice(cursor);
        break;
      }
      if (opening > 0 && line[opening - 1] === '\\') {
        output += line.slice(cursor, opening + 1);
        cursor = opening + 1;
        continue;
      }
      const closing = line.indexOf('$', opening + 1);
      if (closing < 0) {
        output += line.slice(cursor);
        break;
      }
      const body = line.slice(opening + 1, closing);
      output += line.slice(cursor, opening);
      output += looksLikeMath(body) ? `\\(${body}\\)` : line.slice(opening, closing + 1);
      cursor = closing + 1;
    }
    return output;
  }).join('\n');
}

export function prepareTerminalMaths(source) {
  return convertDollarMath(convertBareDisplayBlocks(source));
}

export function terminalBufferText(buffer) {
  if (!buffer || typeof buffer.getLine !== 'function') return '';
  const cursorEnd = Number.isInteger(buffer.baseY) && Number.isInteger(buffer.cursorY)
    ? buffer.baseY + buffer.cursorY + 1
    : buffer.length;
  const end = Math.max(0, Math.min(Number(buffer.length) || 0, cursorEnd));
  const logicalLines = [];
  let current = null;
  for (let index = 0; index < end; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && current != null) current += text;
    else {
      if (current != null) logicalLines.push(current);
      current = text;
    }
  }
  if (current != null) logicalLines.push(current);
  return logicalLines.join('\n');
}
