import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFastaRecords, parseFastaSample } from '../web/fasta-preview.js';

test('FASTA samples join contiguous windows without inventing partial records', () => {
  const result = parseFastaSample({ windows: [
    { offset: 0, size_bytes: 12, eof: false, text: '>alpha\nACGT' },
    { offset: 12, size_bytes: 16, eof: true, text: 'AC\n>beta\nMKW\n' },
  ] });
  assert.deepEqual(result.records.map((record) => ({
    header: record.header, sequence: record.sequence,
    partialStart: record.partialStart, partialEnd: record.partialEnd,
  })), [
    { header: 'alpha', sequence: 'ACGTAC', partialStart: false, partialEnd: false },
    { header: 'beta', sequence: 'MKW', partialStart: false, partialEnd: false },
  ]);
});

test('disjoint FASTA windows label boundary fragments explicitly', () => {
  const result = parseFastaSample({ windows: [
    { offset: 1000, size_bytes: 18, eof: false, text: 'ACGT\n>whole\nTT\n' },
  ] });
  assert.equal(result.records[0].header, 'Fragment at byte 1,000');
  assert.equal(result.records[0].partialStart, true);
  assert.equal(result.records[0].partialEnd, false);
  assert.equal(result.records[1].header, 'whole');
  assert.equal(result.records[1].partialStart, false);
  assert.equal(result.records[1].partialEnd, true);
});

test('copied alignment records are valid wrapped FASTA and identify sampled fragments', () => {
  const text = formatFastaRecords([
    { header: '>alpha\nunsafe', sequence: 'acgt acgtac', partialStart: false, partialEnd: false },
    { header: 'sample fragment', sequence: 'MKWV', partialStart: true, partialEnd: false },
  ], 4);
  assert.equal(text, '>alpha unsafe\nACGT\nACGT\nAC\n>sample fragment [partial sample]\nMKWV\n');
});
