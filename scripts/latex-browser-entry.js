globalThis.MathJax = {
  tex: {
    inlineMath: [['\\(', '\\)']],
    displayMath: [['\\[', '\\]']],
    processEscapes: true,
    packages: { '[+]': ['ams'] },
  },
  chtml: {
    fontURL: '/vendor/mathjax-fonts/woff-v2',
  },
  options: {
    enableMenu: false,
  },
};

export { createLatexEditor, latexDiffChunks } from './latex-editor-entry.js';
export {
  applyLatexReviewDecisions,
  latexReviewArtifactPaths,
  latexReviewMessage,
  LATEX_REVIEW_PROTOCOL,
} from '../web/latex-review.js';
