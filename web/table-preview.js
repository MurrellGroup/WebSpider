const MAX_RENDERED_ROWS = 2_000;
const MAX_RENDERED_COLUMNS = 200;
const MAX_RENDERED_CELLS = 30_000;
const MAX_CELL_CHARACTERS = 4_000;

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

export function detectDelimiter(text, fallback = ',') {
  const candidates = [',', '\t', ';', '|'];
  const counts = new Map(candidates.map((value) => [value, 0]));
  let quoted = false;
  let records = 0;
  const source = String(text || '').slice(0, 128 * 1024);
  for (let index = 0; index < source.length && records < 30; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(character)) {
      counts.set(character, counts.get(character) + 1);
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      records += 1;
    }
  }
  let selected = candidates.includes(fallback) ? fallback : ',';
  for (const candidate of candidates) {
    if (counts.get(candidate) > counts.get(selected)) selected = candidate;
  }
  return counts.get(selected) ? selected : fallback;
}

export function parseDelimitedText(text, delimiter, { complete = true } = {}) {
  const source = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let clippedCells = 0;
  let clippedColumns = 0;
  let limited = false;
  let droppedPartialRow = false;
  let renderedCells = 0;

  const append = (character) => {
    if (field.length < MAX_CELL_CHARACTERS) field += character;
    else if (field.length === MAX_CELL_CHARACTERS) clippedCells += 1;
  };
  const finishField = () => {
    if (row.length < MAX_RENDERED_COLUMNS) row.push(field);
    else clippedColumns += 1;
    field = '';
  };
  const finishRow = (terminated) => {
    finishField();
    if (!terminated && !complete) {
      droppedPartialRow = row.some((value) => value.length > 0);
      row = [];
      return false;
    }
    if (rows.length >= MAX_RENDERED_ROWS || renderedCells + row.length > MAX_RENDERED_CELLS) {
      limited = true;
      row = [];
      return true;
    }
    renderedCells += row.length;
    rows.push(row);
    row = [];
    return false;
  };

  let stopped = false;
  for (let index = 0; index < source.length && !stopped; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { append('"'); index += 1; }
        else quoted = false;
      } else {
        append(character);
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      finishField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      stopped = finishRow(true);
    } else {
      append(character);
    }
  }
  const endsWithRecordBreak = /(?:\r\n|\r|\n)$/u.test(source);
  if (!stopped && source.length && (!endsWithRecordBreak || field.length || row.length)) finishRow(endsWithRecordBreak);
  return { rows, clippedCells, clippedColumns, limited, droppedPartialRow };
}

function delimiterLabel(value) {
  return value === '\t' ? 'Tab' : value === ',' ? 'Comma' : value === ';' ? 'Semicolon' : 'Pipe';
}

export async function createTablePreview(host, { path, format, loadSample }) {
  let disposed = false;
  let generation = 0;
  let sample = null;
  const shell = element('div', 'table-preview');
  const controls = element('form', 'table-controls');
  const delimiterLabelElement = element('label');
  delimiterLabelElement.append(element('span', '', 'Delimiter'));
  const delimiterSelect = element('select');
  for (const [value, label] of [['auto', 'Auto'], [',', 'Comma'], ['\t', 'Tab'], [';', 'Semicolon'], ['|', 'Pipe']]) {
    const option = element('option', '', label); option.value = value; delimiterSelect.append(option);
  }
  delimiterLabelElement.append(delimiterSelect);
  const sizeLabel = element('label');
  sizeLabel.append(element('span', '', 'Read from start'));
  const maxBytes = element('select');
  for (const [value, label] of [[262_144, '256 KiB'], [1_048_576, '1 MiB'], [2_097_152, '2 MiB']]) {
    const option = element('option', '', label); option.value = String(value); if (value === 1_048_576) option.selected = true; maxBytes.append(option);
  }
  sizeLabel.append(maxBytes);
  const headerLabel = element('label', 'table-checkbox');
  const firstRowHeader = element('input'); firstRowHeader.type = 'checkbox'; firstRowHeader.checked = true;
  headerLabel.append(firstRowHeader, element('span', '', 'First row is header'));
  const load = element('button', 'primary', 'Load preview'); load.type = 'submit';
  const scope = element('span', 'table-scope', 'Large files are read from the start only.');
  controls.append(delimiterLabelElement, sizeLabel, headerLabel, load, scope);
  const summary = element('div', 'table-summary');
  const results = element('div', 'table-results');
  shell.append(controls, summary, results);
  host.replaceChildren(shell);

  const renderTable = () => {
    if (!sample || disposed) return;
    const fallback = format === 'tsv' ? '\t' : ',';
    const delimiter = delimiterSelect.value === 'auto' ? detectDelimiter(sample.text, fallback) : delimiterSelect.value;
    const parsed = parseDelimitedText(sample.text, delimiter, { complete: sample.complete_file });
    const rows = parsed.rows;
    const useHeader = firstRowHeader.checked && rows.length > 0;
    const dataRows = useHeader ? rows.slice(1) : rows;
    const columnCount = rows.reduce((maximum, current) => Math.max(maximum, current.length), 0);
    const headers = useHeader
      ? Array.from({ length: columnCount }, (_, index) => rows[0][index] || `Column ${index + 1}`)
      : Array.from({ length: columnCount }, (_, index) => `Column ${index + 1}`);
    summary.replaceChildren();
    for (const [value, label] of [
      [dataRows.length.toLocaleString(), 'rows shown'],
      [columnCount.toLocaleString(), 'columns'],
      [delimiterLabel(delimiter), 'delimiter'],
      [`${formatBytes(sample.bytes_loaded)} / ${formatBytes(sample.size_bytes)}`, sample.complete_file ? 'complete file' : 'bytes loaded'],
    ]) {
      const item = element('div', 'table-stat'); item.append(element('strong', '', value), element('span', '', label)); summary.append(item);
    }
    if (!rows.length || !columnCount) {
      results.replaceChildren(element('div', 'table-empty', 'No complete tabular rows were found in this preview.'));
      return;
    }
    const scroll = element('div', 'table-grid-scroll');
    const table = element('table', 'table-grid');
    const head = element('thead');
    const headerRow = element('tr');
    headerRow.append(element('th', 'table-row-number', '#'));
    headers.forEach((header, index) => {
      const cell = element('th', '', header); cell.title = header; cell.dataset.column = String(index + 1); headerRow.append(cell);
    });
    head.append(headerRow);
    const body = element('tbody');
    const fragment = document.createDocumentFragment();
    dataRows.forEach((values, rowIndex) => {
      const tableRow = element('tr');
      tableRow.append(element('th', 'table-row-number', String(rowIndex + (useHeader ? 2 : 1))));
      for (let column = 0; column < columnCount; column += 1) {
        const value = values[column] || '';
        const cell = element('td', '', value);
        if (value.length >= MAX_CELL_CHARACTERS) cell.classList.add('clipped');
        tableRow.append(cell);
      }
      fragment.append(tableRow);
    });
    body.append(fragment);
    table.append(head, body);
    scroll.append(table);
    results.replaceChildren(scroll);
    const warnings = [];
    if (!sample.complete_file) warnings.push(`Showing complete rows found in the first ${formatBytes(sample.bytes_loaded)}; the final partial row was omitted.`);
    if (parsed.limited) warnings.push('Rendering stopped at the browser row/cell limit.');
    if (parsed.clippedColumns) warnings.push('Columns beyond 200 were omitted.');
    if (parsed.clippedCells) warnings.push('Very long cell values were clipped at 4,000 characters.');
    if (warnings.length) results.append(element('p', 'table-note', warnings.join(' ')));
  };

  const loadPreview = async () => {
    const currentGeneration = ++generation;
    load.disabled = true;
    load.textContent = 'Loading…';
    summary.replaceChildren(element('span', 'table-loading', `Reading ${path}…`));
    results.replaceChildren();
    try {
      const loaded = await loadSample({ maxBytes: Number(maxBytes.value) });
      if (disposed || currentGeneration !== generation) return;
      sample = loaded;
      renderTable();
    } catch (error) {
      if (disposed || currentGeneration !== generation) return;
      summary.replaceChildren();
      results.replaceChildren(element('div', 'table-empty error', error?.message || 'Table preview failed.'));
    } finally {
      if (!disposed && currentGeneration === generation) {
        load.disabled = false;
        load.textContent = 'Load preview';
      }
    }
  };

  controls.addEventListener('submit', (event) => { event.preventDefault(); void loadPreview(); });
  delimiterSelect.addEventListener('change', renderTable);
  firstRowHeader.addEventListener('change', renderTable);
  void loadPreview();
  return {
    dispose() { disposed = true; generation += 1; },
  };
}
