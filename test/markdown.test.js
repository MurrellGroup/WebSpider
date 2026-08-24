import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderMath, stripTerminalFormatting } from '../web/markdown.js';
import { randomIdentifier } from '../web/random.js';

test('browser identifiers work without crypto.randomUUID', () => {
  const identifier = randomIdentifier({
    getRandomValues(bytes) {
      bytes.fill(0xab);
      return bytes;
    },
  });
  assert.equal(identifier, 'ab'.repeat(16));
  assert.match(randomIdentifier(null), /^[0-9a-f]{32}$/);
});

test('readable rendering supports technical markdown, tables, and MathML', () => {
  const output = renderMarkdown(`# Result

The estimate is $\\hat{\\beta}_1 = 2.4$.

$$\\frac{x_1 + x_2}{n}$$

| Measure | Value |
| --- | --- |
| Mean | 2.4 |`);
  assert.match(output, /<h1>Result<\/h1>/);
  assert.match(output, /<math/);
  assert.match(output, /<mfrac>/);
  assert.match(output, /<table>/);
  assert.match(renderMath('x^2'), /<msup>/);
  assert.match(renderMath('\\hat{\\beta}_1'), /<mover/);
});

test('markdown and terminal rendering remain safe for untrusted output', () => {
  const output = renderMarkdown('<script>alert(1)</script> [bad](javascript:alert(1))');
  assert.doesNotMatch(output, /<script>/);
  assert.doesNotMatch(output, /href="javascript:/);
  assert.match(output, /&lt;script&gt;/);
  assert.equal(stripTerminalFormatting('\u001b[31mred\u001b[0m'), 'red');
});
