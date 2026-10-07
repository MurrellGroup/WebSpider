const MAX_RECORDS = 2_000;
const MAX_STORED_RESIDUES = 6_000_000;
const LABEL_WIDTH = 230;
const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 21;
const MAX_SCROLL_WIDTH = 20_000_000;

const PALETTES = {
  nucleotide: [
    { id: 'classic', label: 'Classic bases', colors: { A: '#4fcf8b', C: '#4aa8ff', G: '#f6b84a', T: '#ff6b72', U: '#ff6b72', N: '#657180' } },
    { id: 'purine', label: 'Purine / pyrimidine', colors: { A: '#55c9ff', G: '#55c9ff', C: '#ff8db3', T: '#ff8db3', U: '#ff8db3', N: '#657180' } },
    { id: 'gc', label: 'GC emphasis', colors: { G: '#ffb84d', C: '#ff7f6e', A: '#3c5965', T: '#3c5965', U: '#3c5965', N: '#59626d' } },
  ],
  protein: [
    { id: 'clustal', label: 'Clustal', groups: [
      ['AVLIMFWY', '#4b9cff'], ['KRH', '#f06c7b'], ['DE', '#d95b55'], ['STNQ', '#53c68c'], ['GP', '#d39cff'], ['C', '#f2cf52'],
    ] },
    { id: 'chemistry', label: 'Chemistry', groups: [
      ['KRH', '#4b9cff'], ['DE', '#ff6b72'], ['STNQCY', '#53c68c'], ['AVLIM', '#d8b45c'], ['FW', '#ad86ff'], ['GP', '#ef8fc5'],
    ] },
    { id: 'zappo', label: 'Zappo', groups: [
      ['ILVAM', '#f08ca7'], ['FWY', '#f4a340'], ['KRH', '#579cff'], ['DE', '#ef6464'], ['STNQ', '#65c98b'], ['GP', '#cf77d8'], ['C', '#f2d15f'],
    ] },
    { id: 'hydrophobic', label: 'Hydrophobicity', groups: [
      ['ILVAMFWY', '#efad4e'], ['C', '#d4c858'], ['GP', '#b886db'], ['STNQ', '#58bd91'], ['KRH', '#4b98e8'], ['DE', '#e86666'],
    ] },
  ],
};

function element(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function mergeContiguousWindows(windows) {
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && previous.offset + previous.size_bytes === window.offset) {
      previous.text += window.text;
      previous.size_bytes += window.size_bytes;
      previous.eof = window.eof;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

export function parseFastaSample(sample) {
  const records = [];
  let storedResidues = 0;
  let omittedRecords = 0;
  let clippedResidues = false;
  const pushRecord = (record) => {
    if (!record || (!record.header && !record.parts.length)) return;
    if (records.length >= MAX_RECORDS) { omittedRecords += 1; return; }
    let sequence = record.parts.join('').replace(/\s+/gu, '').toUpperCase();
    const room = Math.max(0, MAX_STORED_RESIDUES - storedResidues);
    if (sequence.length > room) {
      sequence = sequence.slice(0, room);
      record.partialEnd = true;
      clippedResidues = true;
    }
    storedResidues += sequence.length;
    records.push({
      id: `${record.offset}:${records.length}`,
      header: record.header || `Fragment at byte ${record.offset.toLocaleString()}`,
      sequence,
      sourceOffset: record.offset,
      partialStart: Boolean(record.partialStart),
      partialEnd: Boolean(record.partialEnd),
    });
  };

  for (const window of mergeContiguousWindows(sample.windows || [])) {
    let current = null;
    let cursor = 0;
    let lineNumber = 0;
    const expression = /([^\r\n]*)(?:\r\n|\n|\r|$)/gu;
    for (let match = expression.exec(window.text); match && match.index < window.text.length; match = expression.exec(window.text)) {
      const line = match[1];
      const lineOffset = window.offset + match.index;
      if (line.startsWith('>')) {
        if (current) { current.partialEnd = false; pushRecord(current); }
        current = { header: line.slice(1).trim() || '(unnamed sequence)', parts: [], offset: lineOffset, partialStart: false, partialEnd: false };
      } else if (line.trim()) {
        if (!current) {
          current = {
            header: '', parts: [], offset: lineOffset,
            partialStart: window.offset > 0 || lineNumber > 0,
            partialEnd: false,
          };
        }
        current.parts.push(line);
      }
      lineNumber += 1;
      cursor = expression.lastIndex;
      if (expression.lastIndex === match.index) expression.lastIndex += 1;
    }
    if (current) {
      current.partialEnd = !window.eof || cursor < window.text.length;
      pushRecord(current);
    }
  }

  return { records, storedResidues, omittedRecords, clippedResidues };
}

function detectAlphabet(records) {
  let nucleotide = 0;
  let informative = 0;
  for (const record of records) {
    for (const residue of record.sequence.slice(0, 50_000)) {
      if (/[-.*?]/u.test(residue)) continue;
      informative += 1;
      if (/[ACGTUNRYKMSWBDHVX]/u.test(residue)) nucleotide += 1;
    }
  }
  return informative === 0 || nucleotide / informative >= 0.97 ? 'nucleotide' : 'protein';
}

function paletteColor(palette, residue) {
  if (residue === '-' || residue === '.') return '#202833';
  if (palette.colors) return palette.colors[residue] || '#59636f';
  for (const [members, color] of palette.groups) if (members.includes(residue)) return color;
  return '#59636f';
}

function textColor(background) {
  const value = Number.parseInt(background.slice(1), 16);
  const r = value >> 16;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#10151b' : '#f5f7fa';
}

function alignmentState(records) {
  const complete = records.filter((record) => !record.partialStart && !record.partialEnd);
  const lengths = new Set(complete.map((record) => record.sequence.length));
  return { complete, aligned: complete.length > 1 && lengths.size === 1 };
}

function createCanvasViewer(host, records, initialAlphabet) {
  const wrap = element('section', 'fasta-alignment');
  const toolbar = element('div', 'fasta-alignment-toolbar');
  const alphabetLabel = element('label', 'fasta-compact-control');
  alphabetLabel.append(element('span', '', 'Alphabet'));
  const alphabet = element('select');
  for (const [value, label] of [['auto', 'Auto'], ['nucleotide', 'Nucleotide'], ['protein', 'Protein']]) {
    const option = element('option', '', label); option.value = value; alphabet.append(option);
  }
  alphabetLabel.append(alphabet);
  const paletteLabel = element('label', 'fasta-compact-control');
  paletteLabel.append(element('span', '', 'Palette'));
  const paletteSelect = element('select');
  paletteLabel.append(paletteSelect);
  const minus = element('button', 'fasta-icon-button', '−'); minus.type = 'button'; minus.title = 'Show more columns';
  const plus = element('button', 'fasta-icon-button', '+'); plus.type = 'button'; plus.title = 'Enlarge residues';
  const alignment = alignmentState(records);
  const badge = element('span', `fasta-alignment-badge ${alignment.aligned ? 'aligned' : ''}`,
    alignment.aligned ? `${alignment.complete.length} × ${alignment.complete[0].sequence.length.toLocaleString()} alignment` : 'Sequence browser');
  toolbar.append(alphabetLabel, paletteLabel, minus, plus, badge);

  const scroll = element('div', 'fasta-alignment-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', 'Scrollable FASTA sequence viewer');
  const spacer = element('div', 'fasta-alignment-spacer');
  const canvas = element('canvas', 'fasta-alignment-canvas');
  scroll.append(spacer, canvas);
  const selection = element('div', 'fasta-selection-status', 'Click a row for its full identifier. Scroll in either direction to inspect the sampled residues.');
  wrap.append(toolbar, scroll, selection);
  host.append(wrap);

  let disposed = false;
  let frame = null;
  let cellWidth = 12;
  let detectedAlphabet = initialAlphabet;
  let alphabetMode = detectedAlphabet;
  let selectedRow = -1;

  const refreshPaletteOptions = () => {
    alphabetMode = alphabet.value === 'auto' ? detectedAlphabet : alphabet.value;
    const prior = paletteSelect.value;
    paletteSelect.replaceChildren();
    for (const item of PALETTES[alphabetMode]) {
      const option = element('option', '', item.label); option.value = item.id; paletteSelect.append(option);
    }
    if ([...paletteSelect.options].some((option) => option.value === prior)) paletteSelect.value = prior;
  };

  const updateSpace = () => {
    const longest = records.reduce((maximum, record) => Math.max(maximum, record.sequence.length), 0);
    spacer.style.width = `${Math.min(MAX_SCROLL_WIDTH, LABEL_WIDTH + longest * cellWidth)}px`;
    spacer.style.height = `${Math.max(scroll.clientHeight, HEADER_HEIGHT + records.length * ROW_HEIGHT + 2)}px`;
  };

  const render = () => {
    frame = null;
    if (disposed || !scroll.isConnected) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, scroll.clientWidth);
    const height = Math.max(1, scroll.clientHeight);
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth; canvas.height = pixelHeight;
      canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    }
    canvas.style.transform = `translate(${scroll.scrollLeft}px, ${scroll.scrollTop}px)`;
    const context = canvas.getContext('2d', { alpha: false });
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = '#090d12'; context.fillRect(0, 0, width, height);
    context.fillStyle = '#111821'; context.fillRect(0, 0, width, HEADER_HEIGHT);
    context.fillStyle = '#0d131b'; context.fillRect(0, HEADER_HEIGHT, LABEL_WIDTH, height - HEADER_HEIGHT);
    context.strokeStyle = '#26313d'; context.beginPath(); context.moveTo(LABEL_WIDTH - 0.5, 0); context.lineTo(LABEL_WIDTH - 0.5, height); context.stroke();
    context.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';
    context.fillStyle = '#80909f'; context.fillText('Sequence', 10, HEADER_HEIGHT / 2);
    const columnStart = Math.max(0, Math.floor(scroll.scrollLeft / cellWidth));
    const columnRemainder = scroll.scrollLeft % cellWidth;
    context.fillText(`column ${(columnStart + 1).toLocaleString()}`, LABEL_WIDTH + 8, HEADER_HEIGHT / 2);
    const rowStart = Math.max(0, Math.floor(scroll.scrollTop / ROW_HEIGHT));
    const rowRemainder = scroll.scrollTop % ROW_HEIGHT;
    const visibleRows = Math.ceil((height - HEADER_HEIGHT + rowRemainder) / ROW_HEIGHT) + 1;
    const visibleColumns = Math.ceil((width - LABEL_WIDTH + columnRemainder) / cellWidth) + 1;
    const palette = PALETTES[alphabetMode].find((item) => item.id === paletteSelect.value) || PALETTES[alphabetMode][0];
    for (let row = rowStart; row < Math.min(records.length, rowStart + visibleRows); row += 1) {
      const record = records[row];
      const y = HEADER_HEIGHT + (row - rowStart) * ROW_HEIGHT - rowRemainder;
      if (row === selectedRow) { context.fillStyle = '#192631'; context.fillRect(0, y, width, ROW_HEIGHT); }
      context.fillStyle = record.partialStart || record.partialEnd ? '#82909c' : '#d3dce4';
      const marker = record.partialStart || record.partialEnd ? '◐ ' : '';
      const name = `${marker}${record.header}`;
      context.fillText(name.length > 34 ? `${name.slice(0, 33)}…` : name, 9, y + ROW_HEIGHT / 2);
      for (let column = columnStart; column < Math.min(record.sequence.length, columnStart + visibleColumns); column += 1) {
        const residue = record.sequence[column];
        const x = LABEL_WIDTH + (column - columnStart) * cellWidth - columnRemainder;
        const background = paletteColor(palette, residue);
        context.fillStyle = background;
        context.fillRect(x + 0.5, y + 1, Math.max(1, cellWidth - 1), ROW_HEIGHT - 2);
        if (cellWidth >= 10) {
          context.fillStyle = textColor(background);
          context.textAlign = 'center';
          context.fillText(residue, x + cellWidth / 2, y + ROW_HEIGHT / 2);
          context.textAlign = 'start';
        }
      }
    }
  };

  const schedule = () => { if (frame == null) frame = requestAnimationFrame(render); };
  const resize = new ResizeObserver(() => { updateSpace(); schedule(); });
  resize.observe(scroll);
  scroll.addEventListener('scroll', schedule, { passive: true });
  canvas.addEventListener('click', (event) => {
    const row = Math.floor((event.offsetY - HEADER_HEIGHT + scroll.scrollTop) / ROW_HEIGHT);
    if (row < 0 || row >= records.length) return;
    selectedRow = row;
    const record = records[row];
    selection.textContent = `${record.header} · ${record.sequence.length.toLocaleString()} sampled residues${record.partialStart || record.partialEnd ? ' · partial record' : ''}`;
    schedule();
  });
  alphabet.addEventListener('change', () => { refreshPaletteOptions(); schedule(); });
  paletteSelect.addEventListener('change', schedule);
  minus.addEventListener('click', () => { cellWidth = Math.max(4, cellWidth - 2); updateSpace(); schedule(); });
  plus.addEventListener('click', () => { cellWidth = Math.min(22, cellWidth + 2); updateSpace(); schedule(); });
  refreshPaletteOptions();
  updateSpace();
  schedule();
  return {
    dispose() {
      disposed = true;
      resize.disconnect();
      if (frame != null) cancelAnimationFrame(frame);
    },
  };
}

export async function createFastaPreview(host, { path, loadSample }) {
  let disposed = false;
  let canvasViewer = null;
  let generation = 0;
  const shell = element('div', 'fasta-preview');
  const controls = element('form', 'fasta-controls');
  const strategyLabel = element('label'); strategyLabel.append(element('span', '', 'Sample'));
  const strategy = element('select');
  for (const [value, label] of [['uniform', 'Across file'], ['head', 'From start']]) {
    const option = element('option', '', label); option.value = value; strategy.append(option);
  }
  strategyLabel.append(strategy);
  const windowsLabel = element('label'); windowsLabel.append(element('span', '', 'Windows'));
  const windows = element('select');
  for (const value of [4, 8, 16, 32]) { const option = element('option', '', String(value)); option.value = String(value); if (value === 8) option.selected = true; windows.append(option); }
  windowsLabel.append(windows);
  const sizeLabel = element('label'); sizeLabel.append(element('span', '', 'Each window'));
  const windowBytes = element('select');
  for (const [value, label] of [[65_536, '64 KiB'], [262_144, '256 KiB'], [1_048_576, '1 MiB']]) {
    const option = element('option', '', label); option.value = String(value); if (value === 262_144) option.selected = true; windowBytes.append(option);
  }
  sizeLabel.append(windowBytes);
  const load = element('button', 'primary', 'Load sample'); load.type = 'submit';
  const budget = element('span', 'fasta-budget');
  controls.append(strategyLabel, windowsLabel, sizeLabel, load, budget);
  const summary = element('div', 'fasta-summary');
  const results = element('div', 'fasta-results');
  shell.append(controls, summary, results);
  host.replaceChildren(shell);

  const updateBudget = () => {
    const count = strategy.value === 'head' ? 1 : Number(windows.value);
    windowsLabel.classList.toggle('disabled', strategy.value === 'head');
    windows.disabled = strategy.value === 'head';
    budget.textContent = `maximum read ${formatBytes(count * Number(windowBytes.value))}`;
    load.disabled = count * Number(windowBytes.value) > 8 * 1024 * 1024;
  };

  const renderSample = async () => {
    const currentGeneration = ++generation;
    load.disabled = true;
    load.textContent = 'Sampling…';
    summary.replaceChildren(element('span', 'fasta-loading', `Reading bounded windows from ${path}…`));
    try {
      const sample = await loadSample({
        mode: strategy.value,
        windows: Number(windows.value),
        windowBytes: Number(windowBytes.value),
      });
      if (disposed || currentGeneration !== generation) return;
      const parsed = parseFastaSample(sample);
      const alphabet = detectAlphabet(parsed.records);
      const coverage = sample.sampling.complete_file ? 'complete file' : `${(sample.sampling.coverage_fraction * 100).toFixed(sample.sampling.coverage_fraction < 0.01 ? 2 : 1)}% byte coverage`;
      summary.replaceChildren();
      for (const [value, label] of [
        [formatBytes(sample.size_bytes), 'file size'],
        [parsed.records.length.toLocaleString(), 'records/fragments shown'],
        [parsed.storedResidues.toLocaleString(), 'residues held'],
        [coverage, sample.sampling.complete_file ? 'scope' : 'deterministic sample'],
      ]) {
        const item = element('div', 'fasta-stat'); item.append(element('strong', '', value), element('span', '', label)); summary.append(item);
      }
      if (!parsed.records.length) {
        results.replaceChildren(element('div', 'fasta-empty', 'No FASTA records were found in these windows. Increase the window size or choose a denser sample.'));
        return;
      }
      results.replaceChildren();
      canvasViewer?.dispose();
      canvasViewer = createCanvasViewer(results, parsed.records, alphabet);
      const warnings = [];
      if (!sample.sampling.complete_file) warnings.push('Statistics and displayed records describe only the selected byte windows. Half-circle rows cross a sample boundary.');
      if (parsed.omittedRecords) warnings.push(`${parsed.omittedRecords.toLocaleString()} additional sampled records were omitted from rendering.`);
      if (parsed.clippedResidues) warnings.push('Stored residues were capped at 6 million to keep browser memory bounded.');
      if (warnings.length) results.append(element('p', 'fasta-note', warnings.join(' ')));
    } catch (error) {
      if (disposed || currentGeneration !== generation) return;
      summary.replaceChildren();
      results.replaceChildren(element('div', 'fasta-empty error', error?.message || 'FASTA preview failed.'));
    } finally {
      if (!disposed && currentGeneration === generation) {
        load.textContent = 'Load sample';
        updateBudget();
      }
    }
  };

  controls.addEventListener('submit', (event) => { event.preventDefault(); void renderSample(); });
  strategy.addEventListener('change', updateBudget);
  windows.addEventListener('change', updateBudget);
  windowBytes.addEventListener('change', updateBudget);
  updateBudget();
  void renderSample();
  return {
    dispose() {
      disposed = true;
      generation += 1;
      canvasViewer?.dispose();
    },
  };
}
