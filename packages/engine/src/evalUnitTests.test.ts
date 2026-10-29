import { describe, expect, it } from 'vitest';

import { isOcrUnitTest, normalizeUnitTestText, runOcrUnitTest, scoreOcrUnitTests } from './evalUnitTests';

const page = [
  '# Annual Report',
  '',
  'The **quarterly** results were “strong” — revenue grew.',
  '',
  'Second column starts here and continues.',
].join('\n');

describe('olmOCR-style unit tests', () => {
  it('normalizes Markdown emphasis, whitespace, and typography like olmOCR', () => {
    expect(normalizeUnitTestText('The **quarterly**\n\nresults “strong” — up')).toBe('The quarterly results "strong" - up');
  });

  it('checks presence exactly, within maxDiffs, case-insensitively, and inside a window', () => {
    expect(runOcrUnitTest({ id: 'a', type: 'present', text: 'The quarterly results were "strong"' }, page)).toBe(true);
    expect(runOcrUnitTest({ id: 'b', type: 'present', text: 'The quarterIy results' }, page)).toBe(false);
    expect(runOcrUnitTest({ id: 'c', type: 'present', text: 'The quarterIy results', maxDiffs: 1 }, page)).toBe(true);
    expect(runOcrUnitTest({ id: 'd', type: 'present', text: 'annual report', caseSensitive: false }, page)).toBe(true);
    expect(runOcrUnitTest({ id: 'e', type: 'present', text: 'Second column', firstN: 20 }, page)).toBe(false);
    expect(runOcrUnitTest({ id: 'f', type: 'absent', text: 'Page 7' }, page)).toBe(true);
  });

  it('passes order tests only when some match of the first span starts earlier', () => {
    expect(runOcrUnitTest({ id: 'a', type: 'order', before: 'revenue grew', after: 'Second column' }, page)).toBe(true);
    expect(runOcrUnitTest({ id: 'b', type: 'order', before: 'Second column', after: 'revenue grew' }, page)).toBe(false);
    expect(runOcrUnitTest({ id: 'c', type: 'order', before: 'missing span', after: 'Second column' }, page)).toBe(false);
  });

  it('checks Markdown table neighbors and headings', () => {
    const table = [
      '| Group | 2024 | 2025 |',
      '| --- | --- | --- |',
      '| BO | 0.569 | 4.11 |',
      '| CO | 0.31* | 2.00 |',
    ].join('\n');
    expect(runOcrUnitTest({ id: 'a', type: 'table', cell: '0.569', leftHeading: 'BO', topHeading: '2024' }, table)).toBe(true);
    expect(runOcrUnitTest({ id: 'b', type: 'table', cell: '0.569', right: '4.11', down: '0.31*' }, table)).toBe(true);
    expect(runOcrUnitTest({ id: 'c', type: 'table', cell: '0.569', right: '2.00' }, table)).toBe(false);
    expect(runOcrUnitTest({ id: 'd', type: 'table', cell: '0.569' }, 'no table here 0.569')).toBe(false);
  });

  it('resolves HTML colspan, rowspan, and th headings', () => {
    const html = '<table><thead><tr><th colspan="2">Totals</th></tr></thead>'
      + '<tr><td rowspan="2">Q1</td><td>10 &amp; 11</td></tr><tr><td>12</td></tr></table>';
    expect(runOcrUnitTest({ id: 'a', type: 'table', cell: '10 & 11', topHeading: 'Totals', left: 'Q1' }, html)).toBe(true);
    expect(runOcrUnitTest({ id: 'b', type: 'table', cell: '12', left: 'Q1', up: '10 & 11' }, html)).toBe(true);
    const malformed = '<table><tr><td>Total<b>x</b> 5 &lt; 6<script</td><td>9</td></tr></table>';
    expect(runOcrUnitTest({ id: 'c', type: 'table', cell: 'Totalx 5 < 6', right: '9' }, malformed)).toBe(true);
    const lineBreak = '<table><tr><td>Net<br/>total</td><td>9</td></tr></table>';
    expect(runOcrUnitTest({ id: 'd', type: 'table', cell: 'Net total', right: '9' }, lineBreak)).toBe(true);
  });

  it('scores the pass rate across tests and validates the stored shape', () => {
    const tests = [
      { id: 'a', type: 'present', text: 'Annual Report' },
      { id: 'b', type: 'present', text: 'Missing heading' },
    ] as const;
    expect(scoreOcrUnitTests([...tests], page).passRate).toBe(0.5);
    expect(isOcrUnitTest(tests[0])).toBe(true);
    expect(isOcrUnitTest({ id: 'x', type: 'math', math: 'x^2' })).toBe(false);
    expect(isOcrUnitTest({ id: 'x', type: 'present', text: ' ' })).toBe(false);
  });
});
