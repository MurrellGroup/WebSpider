import assert from 'node:assert/strict';
import test from 'node:test';
import { latexDiffChunks } from '../scripts/latex-editor-entry.js';
import {
  applyLatexReviewDecisions, latexReviewArtifactPaths, latexReviewMessage, LATEX_REVIEW_PROTOCOL,
} from '../web/latex-review.js';

test('LaTeX review hunks can be accepted independently without changing rejected text', () => {
  const base = ['Alpha.', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'Omega.'].join('\n');
  const proposal = ['Alpha revised.', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'Omega revised.'].join('\n');
  const chunks = latexDiffChunks(base, proposal);
  assert.equal(chunks.length, 2);
  assert.equal(applyLatexReviewDecisions(base, proposal, chunks, {}), base);
  assert.equal(applyLatexReviewDecisions(base, proposal, chunks,
    Object.fromEntries(chunks.map((chunk) => [chunk.id, 'accepted']))), proposal);
  const firstOnly = applyLatexReviewDecisions(base, proposal, chunks, { [chunks[0].id]: 'accepted' });
  assert.match(firstOnly, /^Alpha revised\./);
  assert.match(firstOnly, /Omega\.$/);
});

test('LaTeX agent requests use durable workspace artifacts and do not repeat selected source', () => {
  const paths = latexReviewArtifactPaths('lrv_abc-123');
  assert.deepEqual(paths, {
    basePath: '.webspider/latex-review-lrv_abc-123-base.tex',
    proposalPath: '.webspider/latex-review-lrv_abc-123-proposal.tex',
  });
  const message = latexReviewMessage({
    id: 'lrv_abc-123', path: 'paper/main.tex', ...paths,
    selection: { fromLine: 12, fromColumn: 3, toLine: 14, toColumn: 8, text: 'expensive selected source' },
    instruction: 'Tighten the argument.',
  });
  assert.match(message, /Follow \.webspider\/LATEX_REVIEW\.md \(protocol v1\)/);
  assert.match(message, /Selection in the base: 12:3-14:8/);
  assert.doesNotMatch(message, /expensive selected source/);
  assert.ok(LATEX_REVIEW_PROTOCOL.length < 1_200);
});
