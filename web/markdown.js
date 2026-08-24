const TEX_SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', infty: '∞',
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', circ: '∘',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', approx: '≈', sim: '∼', equiv: '≡',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', mapsto: '↦',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨', cap: '∩', cup: '∪',
  ldots: '…', cdots: '⋯', dots: '…', degree: '°', prime: '′',
};

const OPERATOR_SYMBOLS = new Set(['∑', '∏', '∫', '∮', '±', '∓', '×', '÷', '·', '≤', '≥', '≠', '≈', '∼', '≡', '→', '←', '↔', '↦', '∈', '∉', '⊂', '⊆', '⊃', '⊇', '∀', '∃', '¬', '∧', '∨', '∩', '∪']);

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

class TexParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse(stop = null) {
    const output = [];
    while (this.index < this.source.length && this.source[this.index] !== stop) {
      const atom = this.atom();
      if (atom) output.push(atom);
    }
    if (stop && this.source[this.index] === stop) this.index += 1;
    return `<mrow>${output.join('')}</mrow>`;
  }

  group() {
    while (this.source[this.index] === ' ') this.index += 1;
    if (this.source[this.index] === '{') {
      this.index += 1;
      return this.parse('}');
    }
    return this.atom(false) || '<mrow></mrow>';
  }

  textGroup() {
    while (this.source[this.index] === ' ') this.index += 1;
    if (this.source[this.index] !== '{') return '';
    this.index += 1;
    let depth = 1;
    let value = '';
    while (this.index < this.source.length && depth > 0) {
      const character = this.source[this.index++];
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      if (depth > 0) value += character;
    }
    return escapeHTML(value);
  }

  command() {
    this.index += 1;
    const start = this.index;
    while (/[A-Za-z]/.test(this.source[this.index] || '')) this.index += 1;
    const name = this.source.slice(start, this.index) || this.source[this.index++] || '';
    if (name === 'frac') return `<mfrac>${this.group()}${this.group()}</mfrac>`;
    if (name === 'sqrt') return `<msqrt>${this.group()}</msqrt>`;
    if (['text', 'textrm', 'textsf', 'texttt', 'operatorname'].includes(name)) return `<mtext>${this.textGroup()}</mtext>`;
    if (['mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'mathbb'].includes(name)) {
      const variant = { mathrm: 'normal', mathbf: 'bold', mathit: 'italic', mathsf: 'sans-serif', mathtt: 'monospace', mathbb: 'double-struck' }[name];
      return `<mstyle mathvariant="${variant}">${this.group()}</mstyle>`;
    }
    if (['hat', 'bar', 'overline', 'vec', 'tilde', 'dot', 'ddot'].includes(name)) {
      const accent = { hat: '^', bar: '¯', overline: '¯', vec: '→', tilde: '~', dot: '˙', ddot: '¨' }[name];
      return `<mover accent="true">${this.group()}<mo>${accent}</mo></mover>`;
    }
    if (name === 'left' || name === 'right') return '';
    if ([',', ';', ':', 'quad', 'qquad'].includes(name)) return '<mspace width="0.5em"></mspace>';
    const symbol = TEX_SYMBOLS[name];
    if (symbol) return OPERATOR_SYMBOLS.has(symbol) ? `<mo>${symbol}</mo>` : `<mi>${symbol}</mi>`;
    return `<mi>${escapeHTML(name)}</mi>`;
  }

  atom(withScripts = true) {
    while (this.source[this.index] === ' ' || this.source[this.index] === '\n') this.index += 1;
    if (this.index >= this.source.length || this.source[this.index] === '}') return '';
    const character = this.source[this.index];
    let base;
    if (character === '\\') base = this.command();
    else if (character === '{') {
      this.index += 1;
      base = this.parse('}');
    } else if (/\d/.test(character)) {
      const start = this.index;
      while (/[\d.,]/.test(this.source[this.index] || '')) this.index += 1;
      base = `<mn>${escapeHTML(this.source.slice(start, this.index))}</mn>`;
    } else if (/[A-Za-z]/.test(character)) {
      const start = this.index;
      while (/[A-Za-z]/.test(this.source[this.index] || '')) this.index += 1;
      base = `<mi>${escapeHTML(this.source.slice(start, this.index))}</mi>`;
    } else {
      this.index += 1;
      base = /[+\-=<>()[\]|,.:]/.test(character)
        ? `<mo>${escapeHTML(character)}</mo>`
        : `<mi>${escapeHTML(character)}</mi>`;
    }
    if (!withScripts) return base;
    let subscript = null;
    let superscript = null;
    while (this.source[this.index] === '_' || this.source[this.index] === '^') {
      const operator = this.source[this.index++];
      if (operator === '_') subscript = this.group();
      else superscript = this.group();
    }
    if (subscript && superscript) return `<msubsup>${base}${subscript}${superscript}</msubsup>`;
    if (subscript) return `<msub>${base}${subscript}</msub>`;
    if (superscript) return `<msup>${base}${superscript}</msup>`;
    return base;
  }
}

export function renderMath(source, display = false) {
  const parser = new TexParser(String(source || '').trim());
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${display ? 'block' : 'inline'}" aria-label="${escapeHTML(source)}">${parser.parse()}</math>`;
}

function safeHref(value) {
  try {
    const url = new URL(value, 'https://webspider.invalid/');
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
    return value;
  } catch {
    return null;
  }
}

function inline(source) {
  const tokens = [];
  const hold = (html) => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };
  let value = String(source ?? '');
  value = value.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHTML(code)}</code>`));
  value = value.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => hold(renderMath(math, false)));
  value = value.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, math) => `${prefix}${hold(renderMath(math, false))}`);
  value = value.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = safeHref(href);
    return safe
      ? hold(`<a href="${escapeHTML(safe)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`)
      : escapeHTML(label);
  });
  value = escapeHTML(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/\n/g, '<br>');
  return value.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] || '');
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function blockStart(lines, index) {
  const line = lines[index] || '';
  const trimmed = line.trim();
  return !trimmed
    || /^```/.test(trimmed)
    || /^(#{1,6})\s+/.test(line)
    || /^>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+\.)\s+/.test(line)
    || /^\s*(?:\$\$|\\\[)/.test(line)
    || /^\s*(?:---+|\*\*\*+)\s*$/.test(line)
    || (line.includes('|') && isTableDivider(lines[index + 1] || ''));
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { index += 1; continue; }
    const fence = trimmed.match(/^```([^\s`]*)/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(`<pre><code${fence[1] ? ` class="language-${escapeHTML(fence[1])}"` : ''}>${escapeHTML(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (trimmed === '$$' || trimmed === '\\[') {
      const end = trimmed === '$$' ? '$$' : '\\]';
      const math = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== end) math.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(renderMath(math.join('\n'), true));
      continue;
    }
    const singleMath = trimmed.match(/^\$\$([\s\S]+)\$\$$/) || trimmed.match(/^\\\[([\s\S]+)\\\]$/);
    if (singleMath) {
      output.push(renderMath(singleMath[1], true));
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      output.push('<hr>');
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoted.push(lines[index++].replace(/^>\s?/, ''));
      output.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    const list = line.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
    if (list) {
      const ordered = /\d+\./.test(list[1]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[1]) !== ordered) break;
        items.push(`<li>${inline(item[2])}</li>`);
        index += 1;
      }
      output.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const headers = tableCells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableCells(lines[index++]));
      output.push(`<div class="table-scroll"><table><thead><tr>${headers.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inline(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && !blockStart(lines, index)) paragraph.push(lines[index++]);
    output.push(`<p>${inline(paragraph.join('\n'))}</p>`);
  }
  return output.join('\n');
}

export function stripTerminalFormatting(source) {
  return String(source ?? '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
