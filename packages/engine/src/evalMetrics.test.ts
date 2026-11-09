import { describe, expect, it } from 'vitest';

import { normalizeOcrText, scoreFields, scoreOcrText, scoreTableCells } from './evalMetrics';

describe('OCR eval metrics', () => {
  it('ignores Markdown presentation while preserving visible text', () => {
    const scores = scoreOcrText('Invoice 42\nTotal 16.00', '# Invoice 42\n\n- Total 16.00');

    expect(scores.normalized_cer).toBe(0);
    expect(scores.wer).toBe(0);
    expect(scores.text_coverage).toBe(1);
    expect(scores.unsupported_text_rate).toBe(0);
  });

  it('gives partial credit and exposes unsupported text', () => {
    const scores = scoreOcrText('invoice 42 total', 'invoice 4Z total invented');

    expect(scores.normalized_edit_similarity).toBeGreaterThan(0.5);
    expect(scores.normalized_edit_similarity).toBeLessThan(1);
    expect(scores.text_coverage).toBeCloseTo(2 / 3);
    expect(scores.unsupported_text_rate).toBeCloseTo(0.5);
  });

  it('scores identical reference and prediction text as a perfect strict match', () => {
    // Strict CER removes Markdown markers from both sides, then keeps case,
    // punctuation, and line boundaries, so identical text must score 0.
    for (const text of ['1. Confirm receipt\n2. Archive the file', 'user_name: a*b', '# Heading\n- item']) {
      const scores = scoreOcrText(text, text);
      expect(scores.cer).toBe(0);
      expect(scores.normalized_cer).toBe(0);
    }
  });

  it('keeps strict CER sensitive to case and punctuation', () => {
    const scores = scoreOcrText('Total: 16.00', 'total 16.00');
    expect(scores.cer).toBeGreaterThan(0);
    expect(scores.normalized_cer).toBeGreaterThan(0);
  });

  it('normalizes Unicode typography consistently', () => {
    expect(normalizeOcrText('“TOTAL” — １２３')).toBe('"total" - 123');
  });

  it('penalizes missing, wrong, and invented structured fields', () => {
    const scores = scoreFields(
      { invoice_number: 'INV-42', total: '16.00', vendor: 'Northwind' },
      {
        invoice_number: { value: 'INV-42' },
        total: { value: '17.00' },
        invented: { value: 'Acme' },
      },
      { criticalFields: ['invoice_number', 'total'] },
    );

    expect(scores.field_precision).toBeCloseTo(1 / 3);
    expect(scores.field_recall).toBeCloseTo(1 / 3);
    expect(scores.field_f1).toBeCloseTo(1 / 3);
    expect(scores.critical_field_exact_match).toBe(0.5);
  });

  it('scores table cells independent of object key order', () => {
    const scores = scoreTableCells(
      [{ item: 'Milk', quantity: '1', price: '3.50' }],
      [{ price: '3.50', item: 'Milk', quantity: '1' }],
    );

    expect(scores.table_cell_f1).toBe(1);
  });

  it('keeps cells whose values end with a colon, such as row labels', () => {
    const reference = [['Subtotal:', '10.00'], ['Tax:', '1.00'], ['Total:', '11.00']];
    const wrongLabels = [['Subtotal:', '10.00'], ['Discount:', '1.00'], ['Grand total:', '11.00']];

    expect(scoreTableCells(reference, reference).table_cell_f1).toBe(1);
    expect(scoreTableCells(reference, wrongLabels).table_cell_f1).toBeCloseTo(4 / 6);
    expect(scoreTableCells([{ label: 'Total:' }], [{ label: 'Tax:' }]).table_cell_f1).toBe(0);
  });

  it('ignores empty and Markdown separator cells', () => {
    const scores = scoreTableCells(
      [['Item', 'Price'], ['Milk', '3.50']],
      [['Item', 'Price'], ['---', ':---:'], ['Milk', '3.50', ''], ['', null]],
    );

    expect(scores.table_cell_f1).toBe(1);
  });
});
