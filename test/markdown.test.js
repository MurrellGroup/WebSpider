import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, renderMath, stripTerminalFormatting } from '../web/markdown.js';
import { randomIdentifier } from '../web/random.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

test('an exited primary agent terminal becomes read-only with a restart action', () => {
  const application = fs.readFileSync(path.join(repository, 'web', 'app.js'), 'utf8');
  assert.match(application, /Restart agent/);
  assert.match(application, /interactive \? 'Take control' : 'Not running'/);
  assert.match(application, /if \(interactive\) \{[\s\S]*state\.terminalInputSubscription = emulator\.onData\(handleTerminalData\)/);
  assert.match(application, /state\.selectedAgent\.state !== previousAgentState/);
});

test('terminal text-box mode is opt-in and uses durable messages for primary agents', () => {
  const application = fs.readFileSync(path.join(repository, 'web', 'app.js'), 'utf8');
  assert.match(application, /terminalInputMode: 'direct'/);
  assert.match(application, /data-terminal-input-mode="compose"[^>]*>Text box/);
  assert.match(application, /terminal-compose-form/);
  assert.match(application, /submitTerminalComposition/);
  assert.match(application, /terminalBracketedPaste/);
  assert.match(application, /\\u001b\[200~/);
  assert.match(application, /transmitTerminalInput\(payload\)/);
  assert.match(application, /terminalCompositionTimer = setTimeout/);
  assert.match(application, /queueTerminalInput\('\\r'\)/);
  assert.match(application, /terminal\?\.kind === 'primary_agent'/);
  assert.match(application, /idempotency-key.*randomIdentifier/s);
});
