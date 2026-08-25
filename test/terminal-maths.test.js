import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareTerminalMaths, terminalBufferText } from '../web/terminal-maths.js';

test('terminal buffer transcript follows xterm wrapping and stops at the cursor row', () => {
  const lines = [
    { isWrapped: false, translateToString: () => 'first line' },
    { isWrapped: false, translateToString: () => 'a wrapped ' },
    { isWrapped: true, translateToString: () => 'continuation' },
    { isWrapped: false, translateToString: () => '' },
    { isWrapped: false, translateToString: () => 'unused screen row' },
  ];
  const buffer = { length: lines.length, baseY: 0, cursorY: 3, getLine: (index) => lines[index] };
  assert.equal(terminalBufferText(buffer), 'first line\na wrapped continuation\n');
});

test('Maths mode changes only recognized math delimiters', () => {
  const input = `terminal text stays put

  [
  \\boxed{\\frac{x_0}{\\sqrt{1-\\bar\\alpha_t}}}
  ]

shell$ echo $HOME and $PWD
inline $x_0$ remains on this line`;
  const result = prepareTerminalMaths(input);
  assert.match(result, /terminal text stays put/);
  assert.match(result, /\\\[\n  \\boxed/);
  assert.match(result, /\\boxed\{\\frac\{x_0\}/);
  assert.match(result, /shell\$ echo \$HOME and \$PWD/);
  assert.match(result, /inline \\\(x_0\\\) remains/);
});

test('Maths mode does not mistake a formatted JSON array for bare display math', () => {
  const json = '[\n  {\n    "node_id": "nod_123"\n  }\n]';
  assert.equal(prepareTerminalMaths(json), json);
});
