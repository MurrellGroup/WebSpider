import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, parseDelimitedText } from '../web/table-preview.js';

test('CSV parsing preserves quoted delimiters, escaped quotes, and embedded newlines', () => {
  const parsed = parseDelimitedText('name,note,value\nalpha,"hello, world",1\nbeta,"line one\nline ""two""",2\n', ',', { complete: true });
  assert.deepEqual(parsed.rows, [
    ['name', 'note', 'value'],
    ['alpha', 'hello, world', '1'],
    ['beta', 'line one\nline "two"', '2'],
  ]);
  assert.equal(parsed.droppedPartialRow, false);
});

test('a bounded table sample omits its incomplete final row', () => {
  const parsed = parseDelimitedText('a,b\n1,2\nunfinished,va', ',', { complete: false });
  assert.deepEqual(parsed.rows, [['a', 'b'], ['1', '2']]);
  assert.equal(parsed.droppedPartialRow, true);
});

test('delimiter detection ignores separators inside quoted fields', () => {
  assert.equal(detectDelimiter('name\tnote\nalpha\t"x,y,z"\n', ','), '\t');
  assert.equal(detectDelimiter('name;note\nalpha;"x,y,z"\n', ','), ';');
});
