import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderMath, stripTerminalFormatting } from '../web/markdown.js';

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
