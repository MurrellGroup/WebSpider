export function applyLatexReviewDecisions(base, proposal, chunks, decisions = {}) {
  let cursor = 0;
  let output = '';
  for (const chunk of chunks) {
    if (chunk.fromA < cursor || chunk.toA < chunk.fromA || chunk.toB < chunk.fromB) {
      throw new Error('The LaTeX proposal contains overlapping or invalid diff chunks.');
    }
    output += base.slice(cursor, chunk.fromA);
    output += decisions[chunk.id] === 'accepted'
      ? proposal.slice(chunk.fromB, chunk.toB)
      : base.slice(chunk.fromA, chunk.toA);
    cursor = chunk.toA;
  }
  return output + base.slice(cursor);
}

export function latexReviewArtifactPaths(reviewId) {
  const safe = String(reviewId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(-48);
  if (!safe) throw new Error('A review ID is required.');
  return {
    basePath: `.webspider/latex-review-${safe}-base.tex`,
    proposalPath: `.webspider/latex-review-${safe}-proposal.tex`,
  };
}

export function latexReviewMessage(review) {
  const selections = (review.selections?.length ? review.selections : [review.selection]).filter(Boolean);
  const ranges = selections.map((selection) => `${selection.fromLine}:${selection.fromColumn}-${selection.toLine}:${selection.toColumn}`);
  const selectionLine = ranges.length === 1
    ? `Selection in the base: ${ranges[0]}`
    : `Selections in the base (${ranges.length}): ${ranges.join('; ')}`;
  return `[WebSpider LaTeX review request]\nReview: ${review.id}\nFollow .webspider/LATEX_REVIEW.md (protocol v1).\nTarget: ${review.path}\nImmutable base: ${review.basePath}\nWrite the complete proposed document to: ${review.proposalPath}\n${selectionLine}\nRequest: ${review.instruction}\nDo not modify the target file. Reply with “LaTeX review ${review.id} ready” only after the proposal file is complete.`;
}

export const LATEX_REVIEW_PROTOCOL = `# WebSpider LaTeX review protocol v1

For a message headed \`[WebSpider LaTeX review request]\`:

1. Read the immutable base file and every requested selection in it.
2. Apply the request to all listed selections with sound academic judgment. Keep unrelated text unchanged.
3. Write the complete proposed LaTeX document to the exact proposal path from the message. Never modify the target file.
4. Ensure the proposal remains valid UTF-8 text and preserve the document's existing style and line endings where practical.
5. Reply with the requested ready message only after the proposal file is complete. WebSpider computes the diff and handles approval; do not commit or apply the proposal yourself.
`;
