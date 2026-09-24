import { basicSetup } from 'codemirror';
import { EditorState, StateEffect, StateField, Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { Chunk } from '@codemirror/merge';

const latexTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: '#d7e0e3',
    backgroundColor: '#080b10',
    fontSize: '12px',
  },
  '.cm-content': {
    caretColor: '#8ef0c7',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    lineHeight: '1.55',
    padding: '12px 0 30vh',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#8ef0c7' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#28483f',
  },
  '.cm-tagged-selection': {
    backgroundColor: 'rgba(124, 184, 255, .14)',
    outline: '1px solid rgba(124, 184, 255, .4)',
    borderRadius: '2px',
  },
  '.cm-gutters': {
    color: '#647080',
    backgroundColor: '#0d1118',
    borderRight: '1px solid #202733',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(124, 184, 255, .07)' },
  '.tok-keyword, .tok-metaName, .tok-typeName': { color: '#7cb8ff' },
  '.tok-string, .tok-inserted': { color: '#8ef0c7' },
  '.tok-comment': { color: '#6f7d8e', fontStyle: 'italic' },
  '.tok-number, .tok-bool': { color: '#d4a7ff' },
  '.tok-heading, .tok-strong': { color: '#f0ca74', fontWeight: '600' },
  '.tok-link, .tok-url': { color: '#78dce8' },
}, { dark: true });

const setTaggedSelections = StateEffect.define();
const taggedSelectionsField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let mapped = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setTaggedSelections)) continue;
      const length = transaction.state.doc.length;
      mapped = Decoration.set(effect.value
        .map(({ from, to }) => ({ from: Math.max(0, Math.min(length, from)), to: Math.max(0, Math.min(length, to)) }))
        .filter(({ from, to }) => to > from)
        .map(({ from, to }) => Decoration.mark({ class: 'cm-tagged-selection' }).range(from, to)), true);
    }
    return mapped;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function normalizedDocument(value) {
  return String(value ?? '').replaceAll('\r\n', '\n');
}

export function createLatexEditor(parent, { document = '', onChange = null, onSelection = null } = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: normalizedDocument(document),
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        latexTheme,
        taggedSelectionsField,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange?.(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) onSelection?.();
        }),
      ],
    }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      const next = normalizedDocument(value);
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    selection() {
      const range = view.state.selection.main;
      const documentText = view.state.doc;
      const fromLine = documentText.lineAt(range.from);
      const toLine = documentText.lineAt(range.to);
      return {
        from: range.from,
        to: range.to,
        text: documentText.sliceString(range.from, range.to),
        fromLine: fromLine.number,
        fromColumn: range.from - fromLine.from + 1,
        toLine: toLine.number,
        toColumn: range.to - toLine.from + 1,
      };
    },
    select(from, to = from) {
      const length = view.state.doc.length;
      const anchor = Math.max(0, Math.min(length, Number(from) || 0));
      const head = Math.max(anchor, Math.min(length, Number(to) || anchor));
      view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
      view.focus();
    },
    setTaggedRanges(ranges = []) {
      view.dispatch({ effects: setTaggedSelections.of(ranges) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

export function latexDiffChunks(base, proposal) {
  const left = Text.of(normalizedDocument(base).split('\n'));
  const right = Text.of(normalizedDocument(proposal).split('\n'));
  return Chunk.build(left, right, { scanLimit: 20_000, timeout: 1_000 }).map((chunk, index) => {
    const fromA = Math.min(left.length, chunk.fromA);
    const toA = Math.min(left.length, chunk.toA);
    const fromB = Math.min(right.length, chunk.fromB);
    const toB = Math.min(right.length, chunk.toB);
    return {
      id: `${index}-${fromA}-${toA}-${fromB}-${toB}`,
      fromA,
      toA,
      fromB,
      toB,
      lineA: left.lineAt(fromA).number,
      lineB: right.lineAt(fromB).number,
      before: left.sliceString(fromA, toA),
      after: right.sliceString(fromB, toB),
      precise: chunk.precise,
    };
  });
}
