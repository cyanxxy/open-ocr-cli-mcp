import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockTemplateGenerateContent, mockTemplateGenerateContentStream } = vi.hoisted(() => ({
  mockTemplateGenerateContent: vi.fn(),
  mockTemplateGenerateContentStream: vi.fn(),
}));

import type { ExtractionPreset, PresetStructuredOutput } from '../gemini/types';
import { findSchemaCompatibilityIssues } from '../gemini/schemaCompat';
import {
  buildPresetCsv,
  buildPresetMarkdown,
  buildPresetPrompt,
  buildPresetResponseSchema,
  normalizeFieldValue,
  presetRunResultFromText,
  runExtractionPreset,
} from './engine';
import { EXTRACTION_PRESETS, getExtractionPreset } from './presets';

// Mutable payload so individual tests can drive the mocked model response
// (used to exercise the validation report and row-cap behavior).
let mockModelPayload: unknown = {
  documentType: 'Invoice',
  summary: 'Structured extraction for invoice.',
  fields: {
    total: { value: '1471.5', confidence: 0.97 },
    currency: { value: 'USD', confidence: 0.99 },
  },
  rows: [],
};

mockTemplateGenerateContent.mockImplementation(async () => {
  await Promise.resolve();
  return {
    text: JSON.stringify(mockModelPayload),
    candidates: [{ finishReason: 'STOP' }],
  };
});

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = {
        generateContent: mockTemplateGenerateContent,
        generateContentStream: mockTemplateGenerateContentStream,
      };
    },
  };
});

const testClientConfig = {
  apiKey: 'test-key',
  model: 'gemini-3.5-flash' as const,
  thinkingConfig: { level: 'MINIMAL' as const, includeThoughts: false },
};

describe('template engine helpers', () => {
  it('builds markdown with escaped field and row values', () => {
    const preset = getExtractionPreset('invoice');
    const result: PresetStructuredOutput = {
      presetId: 'invoice',
      documentType: 'Invoice',
      summary: 'Structured extraction for invoice.',
      fields: {
        invoice_number: { value: 'INV|2026|0142', confidence: 0.94, required: true, type: 'text' },
        invoice_date: { value: '2026-02-18', confidence: 0.91, required: true, type: 'date' },
        due_date: { value: null, confidence: 0.2, required: false, type: 'date' },
        vendor_name: { value: 'Northwind Supply Co.', confidence: 0.96, required: true, type: 'text' },
        customer_name: { value: 'Acme Logistics', confidence: 0.88, required: false, type: 'text' },
        currency: { value: 'USD', confidence: 0.99, required: false, type: 'currency' },
        subtotal: { value: '1250.00', confidence: 0.95, required: false, type: 'currency' },
        tax: { value: '112.50', confidence: 0.92, required: false, type: 'currency' },
        total: { value: '1362.50', confidence: 0.97, required: true, type: 'currency' },
      },
      rows: [
        {
          description: 'Support | hours',
          quantity: '3',
          unit_price: '50.00',
          line_total: '150.00',
        },
      ],
      warnings: ['Low confidence on due date'],
    };

    const markdown = buildPresetMarkdown(result, preset);

    expect(markdown).toContain('# Invoice Extraction');
    expect(markdown).toContain('INV\\|2026\\|0142');
    expect(markdown).toContain('Support \\| hours');
    expect(markdown).toContain('Not found');
    expect(markdown).toContain('## Warnings');
  });

  it('builds CSV only for table presets and escapes quoted values', () => {
    const tablePreset = getExtractionPreset('receipt');
    const recordPreset = getExtractionPreset('resume');

    const tableResult: PresetStructuredOutput = {
      presetId: 'receipt',
      documentType: 'Receipt',
      summary: 'Structured extraction for receipt.',
      fields: {},
      rows: [
        { item: 'Coffee "Beans"', quantity: '2', price: '8.50' },
      ],
    };

    expect(buildPresetCsv(tableResult, tablePreset)).toBe(
      'item,quantity,price\n"Coffee ""Beans""",2,8.50',
    );

    expect(buildPresetCsv(tableResult, recordPreset)).toBeUndefined();
  });

  it('builds prompts that reflect the preset output shape', () => {
    const invoicePrompt = buildPresetPrompt(getExtractionPreset('invoice'));
    const resumePrompt = buildPresetPrompt(getExtractionPreset('resume'));

    expect(invoicePrompt).toContain('Also extract line-item rows into a "rows" array of at most 500 entries.');
    expect(invoicePrompt).toContain('description, quantity, unit_price, line_total');
    expect(resumePrompt).toContain('Do not include a "rows" array unless the preset requires one.');
  });

  // Every preset shipped a response schema whose `maxItems: 500` on the rows
  // array blew the provider's grammar-complexity budget, so template mode 400'd
  // on the first request for every document. The old tests all passed because
  // they only ever asserted on the parsed result, never on what went over the
  // wire. These assert the schema itself stays inside the verified subset.
  describe.each(EXTRACTION_PRESETS.map((preset) => preset.id))('%s response schema', (presetId) => {
    it('uses only constructs the structured-output API accepts', () => {
      const schema = buildPresetResponseSchema(getExtractionPreset(presetId));

      expect(findSchemaCompatibilityIssues(schema)).toEqual([]);
    });

    it('leaves the row cap out of the wire schema and enforces it after parsing', () => {
      const schema = buildPresetResponseSchema(getExtractionPreset(presetId)) as {
        properties: { rows: Record<string, unknown> };
      };

      expect(schema.properties.rows).not.toHaveProperty('maxItems');
      expect(schema.properties.rows).not.toHaveProperty('minItems');
    });
  });

  it('caps rows after parsing now that the schema no longer bounds them', () => {
    const preset = getExtractionPreset('invoice');
    const rows = Array.from({ length: 520 }, (_, index) => ({ description: `Line ${index + 1}` }));

    const result = presetRunResultFromText(
      JSON.stringify({ documentType: 'Invoice', summary: 'Long invoice', fields: {}, rows }),
      preset,
    );

    expect(result.json.rows).toHaveLength(500);
    expect(result.json.validationErrors ?? []).toContainEqual(
      expect.stringContaining('Row output truncated to 500 rows'),
    );
  });

  it('normalizes numeric currency fields to two decimal places', async () => {
    const preset = getExtractionPreset('invoice');

    const result = await runExtractionPreset(
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash',
        thinkingConfig: { level: 'MINIMAL', includeThoughts: false },
      },
      preset,
    );

    expect(result.json.fields.total?.value).toBe('1471.50');
    expect(result.json.fields.currency?.value).toBe('USD');
    expect(mockTemplateGenerateContent).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'gemini-3.5-flash',
      config: expect.objectContaining({
        responseMimeType: 'application/json',
        responseJsonSchema: expect.objectContaining({
          type: 'object',
          required: ['documentType', 'summary', 'fields', 'warnings'],
        }) as unknown,
      }) as unknown,
    }));
  });
});

describe('normalizeFieldValue number/currency parsing', () => {
  it('rejects nested and non-finite values instead of fabricating scalar text', () => {
    expect(() => normalizeFieldValue({ amount: 42 }, 'currency')).toThrow(/expected schema/);
    expect(() => normalizeFieldValue([{ text: 'item' }], 'list')).toThrow(/expected schema/);
    expect(() => normalizeFieldValue(Infinity, 'number')).toThrow(/expected schema/);
    expect(() => normalizeFieldValue(NaN, 'currency')).toThrow(/expected schema/);
  });

  it('parses US-formatted numbers', () => {
    expect(normalizeFieldValue('1,234.56', 'number')).toBe(1234.56);
    expect(normalizeFieldValue('1,234', 'number')).toBe(1234);
    expect(normalizeFieldValue('1,234,567', 'number')).toBe(1234567);
  });

  it('parses European-formatted numbers', () => {
    expect(normalizeFieldValue('1.234,56', 'number')).toBe(1234.56);
    expect(normalizeFieldValue('1.234.567', 'number')).toBe(1234567);
    expect(normalizeFieldValue('1,5', 'number')).toBe(1.5);
  });

  it('parses plain and signed numbers', () => {
    expect(normalizeFieldValue('1234', 'number')).toBe(1234);
    expect(normalizeFieldValue('-1.234,56', 'number')).toBe(-1234.56);
    expect(normalizeFieldValue(19.5, 'number')).toBe(19.5);
  });

  it('falls back to the trimmed string for non-numeric values', () => {
    expect(normalizeFieldValue('not a number', 'number')).toBe('not a number');
    expect(normalizeFieldValue('  N/A  ', 'number')).toBe('N/A');
  });

  it('normalizes currency across US/European/plain formats to two decimals', () => {
    expect(normalizeFieldValue('1,234.56', 'currency')).toBe('1234.56');
    expect(normalizeFieldValue('1.234,56', 'currency')).toBe('1234.56');
    expect(normalizeFieldValue('€1.234,56', 'currency')).toBe('1234.56');
    expect(normalizeFieldValue('1234', 'currency')).toBe('1234.00');
    expect(normalizeFieldValue('1.234.567', 'currency')).toBe('1234567.00');
    expect(normalizeFieldValue(1471.5, 'currency')).toBe('1471.50');
  });

  it('keeps non-numeric currency values verbatim', () => {
    expect(normalizeFieldValue('USD', 'currency')).toBe('USD');
  });

  // audit T-03: currency identifier captured as text stays untouched; the
  // numeric currency type continues to coerce numbers.
  it('treats a currency code as text rather than a numeric amount', () => {
    expect(normalizeFieldValue('USD', 'text')).toBe('USD');
    expect(normalizeFieldValue('EUR 1,234.56', 'text')).toBe('EUR 1,234.56');
    expect(normalizeFieldValue('USD', 'currency')).not.toMatch(/^\d/);
  });
});

// audit H-11: CSV formula injection
describe('buildPresetCsv formula-injection neutralization', () => {
  const tablePreset = getExtractionPreset('receipt');

  const csvFor = (rows: Array<Record<string, string>>): string | undefined =>
    buildPresetCsv(
      {
        presetId: 'receipt',
        documentType: 'Receipt',
        summary: 'x',
        fields: {},
        rows,
      },
      tablePreset,
    );

  it('prefixes formula-leading cells (=, @, +/- that are not plain numbers) with a single quote', () => {
    const csv = csvFor([
      { item: '=SUM(A1:A9)', quantity: '+1+2', price: '-2+3' },
      { item: '@cmd', quantity: '1', price: '2' },
    ]);

    expect(csv).toBeDefined();
    const lines = (csv as string).split('\n');
    // Header then two data rows.
    expect(lines[1].startsWith("'=SUM(A1:A9)")).toBe(true);
    expect(lines[1]).toContain("'+1+2"); // +1+2 is not a well-formed number -> escaped
    expect(lines[1]).toContain("'-2+3"); // -2+3 is a formula, not a number -> escaped
    expect(lines[2].startsWith("'@cmd")).toBe(true);
  });

  it('does NOT mangle legitimate negative/positive numeric amounts', () => {
    const csv = csvFor([
      { item: 'Refund', quantity: '1', price: '-50.00' },
      { item: 'Tip', quantity: '1', price: '+3.5' },
    ]);
    expect(csv).toBeDefined();
    const lines = (csv as string).split('\n');
    // Well-formed numbers must be exported verbatim so non-Excel consumers
    // (Sheets, pandas, DB imports) read them as numbers, not text.
    expect(lines[1]).toContain('-50.00');
    expect(lines[1]).not.toContain("'-50.00");
    expect(lines[2]).toContain('+3.5');
    expect(lines[2]).not.toContain("'+3.5");
  });

  it('quotes and prefixes cells beginning with a tab or carriage return', () => {
    const csv = csvFor([{ item: '\t=2+2', quantity: '\rdanger', price: '1' }]);
    expect(csv).toBeDefined();
    const dataRow = (csv as string).split('\n')[1];
    // Leading TAB/CR triggers both the formula prefix and double-quote wrapping.
    expect(dataRow).toContain("\"'\t=2+2\"");
    expect(dataRow).toContain("\"'\rdanger\"");
  });

  it('leaves benign cells untouched', () => {
    const csv = csvFor([{ item: 'Coffee', quantity: '2', price: '8.50' }]);
    expect(csv).toBe('item,quantity,price\nCoffee,2,8.50');
  });
});

// audit T-05: markdown escaping beyond pipes
describe('buildPresetMarkdown cell hardening', () => {
  const preset = getExtractionPreset('resume');

  const markdownForField = (value: string): string =>
    buildPresetMarkdown(
      {
        presetId: 'resume',
        documentType: 'Resume',
        summary: 'x',
        fields: {
          full_name: { value, confidence: 0.9, required: true, type: 'text' },
        },
      },
      preset,
    );

  it('collapses newlines so the table row stays on one line', () => {
    const md = markdownForField('line1\nline2');
    const fullNameRow = md.split('\n').find((line) => line.includes('full_name'));
    expect(fullNameRow).toBeDefined();
    expect(fullNameRow).toContain('line1 line2');
  });

  it('escapes backticks and angle brackets to block code spans and raw HTML', () => {
    const md = markdownForField('`code` <script>alert(1)</script>');
    expect(md).toContain('\\`code\\`');
    expect(md).toContain('&lt;script&gt;');
    expect(md).not.toContain('<script>');
  });
});

// audit T-01 / T-02 / T-09: keying contract, validation report, row cap
describe('preset normalization contract and validation', () => {
  afterEach(() => {
    mockModelPayload = {
      documentType: 'Invoice',
      summary: 'Structured extraction for invoice.',
      fields: { total: { value: '1471.5', confidence: 0.97 }, currency: { value: 'USD', confidence: 0.99 } },
      rows: [],
    };
  });

  it('keys fields by rule.field for every shipped preset rule (T-01)', async () => {
    for (const presetId of ['invoice', 'receipt', 'resume', 'business-card']) {
      const preset: ExtractionPreset = getExtractionPreset(presetId);
      mockModelPayload = { documentType: 'X', summary: 'y', fields: {}, rows: [] };
      const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, preset);
      for (const rule of preset.rules) {
        expect(result.json.fields).toHaveProperty(rule.field);
      }
    }
  });

  it('reports a required field that is missing (T-02)', async () => {
    const preset = getExtractionPreset('invoice');
    // invoice_number, invoice_date, vendor_name, total are required.
    mockModelPayload = { documentType: 'Invoice', summary: 'y', fields: {}, rows: [] };
    const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, preset);

    expect(result.json.validationErrors).toBeDefined();
    expect(result.json.validationErrors?.some((msg) => msg.includes('invoice_number'))).toBe(true);
    expect(result.json.validationErrors?.some((msg) => msg.includes('total'))).toBe(true);
    // The validation report is surfaced in the markdown artifact.
    expect(result.markdown).toContain('## Validation');
  });

  it('rejects a valid-looking structured response that stopped at MAX_TOKENS', async () => {
    const preset = getExtractionPreset('invoice');
    mockTemplateGenerateContent.mockResolvedValueOnce({
      text: JSON.stringify(mockModelPayload),
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });

    await expect(runExtractionPreset(
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      testClientConfig,
      preset,
    )).rejects.toThrow(/incomplete output/i);
  });

  it('rejects a preset stream that ends without terminal STOP', async () => {
    const preset = getExtractionPreset('invoice');
    function* chunks() {
      yield { text: JSON.stringify(mockModelPayload), candidates: [{}] };
    }
    mockTemplateGenerateContentStream.mockResolvedValueOnce(chunks());

    await expect(runExtractionPreset(
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      testClientConfig,
      preset,
      undefined,
      { onProgress: vi.fn() },
    )).rejects.toThrow(/without a terminal STOP/i);
  });

  it('caps rows at the limit and reports truncation (T-09)', async () => {
    const preset = getExtractionPreset('receipt');
    const rows = Array.from({ length: 600 }, (_unused, index) => ({ item: `item-${index}`, quantity: '1', price: '1.00' }));
    mockModelPayload = { documentType: 'Receipt', summary: 'y', fields: {}, rows };

    const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, preset);

    expect(result.json.rows?.length).toBe(500);
    expect(result.json.validationErrors?.some((msg) => msg.includes('truncated'))).toBe(true);
  });

  it('reports values that violate a rule pattern (T-02)', async () => {
    const patternPreset: ExtractionPreset = {
      id: 'invoice',
      label: 'Invoice',
      description: 'pattern test',
      outputShape: 'record',
      rules: [
        { id: 'code', field: 'code', description: 'fixed code', type: 'text', pattern: '^[A-Z]{3}-\\d{4}$' },
      ],
    };
    mockModelPayload = { documentType: 'X', summary: 'y', fields: { code: { value: 'not-a-code', confidence: 0.9 } } };

    const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, patternPreset);
    expect(result.json.validationErrors?.some((msg) => msg.includes('code') && msg.includes('does not match'))).toBe(true);
  });

  it('bounds an oversized string field value (T-09)', async () => {
    const preset = getExtractionPreset('resume');
    const huge = 'x'.repeat(50000);
    mockModelPayload = { documentType: 'Resume', summary: 'y', fields: { headline: { value: huge, confidence: 0.9 } } };

    const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, preset);
    const headline = result.json.fields.headline?.value;
    expect(typeof headline).toBe('string');
    expect((headline as string).length).toBeLessThanOrEqual(20000);
  });

  it('does not emit validationErrors when every required field is present (T-02)', async () => {
    const preset = getExtractionPreset('invoice');
    mockModelPayload = {
      documentType: 'Invoice',
      summary: 'y',
      fields: {
        invoice_number: { value: 'INV-1', confidence: 0.9 },
        invoice_date: { value: '2026-01-01', confidence: 0.9 },
        vendor_name: { value: 'Acme', confidence: 0.9 },
        total: { value: '10.00', confidence: 0.9 },
      },
      rows: [],
    };

    const result = await runExtractionPreset('data:application/pdf;base64,ZmFrZQ==', 'application/pdf', testClientConfig, preset);
    expect(result.json.validationErrors).toBeUndefined();
  });
});


// Fail closed on malformed preset JSON so empty/primitive payloads never become
// plausible mostly-empty extraction results (handoff: parsePresetPayload).
describe('parsePresetPayload schema validation', () => {
  const preset = getExtractionPreset('invoice');
  const schemaError = /Preset extraction response did not match the expected schema/;

  it.each([
    ['42', '42'],
    ['empty object', '{}'],
    ['fields array', '{"fields":[]}'],
    ['non-numeric confidence', '{"fields":{"total":{"value":"42","confidence":"high"}}}'],
    ['warnings not an array', '{"fields":{},"warnings":"none"}'],
    ['nested field object', '{"fields":{"total":{"value":{"amount":42},"confidence":0.9}}}'],
    ['nested list entries', '{"fields":{"items":{"value":[{"name":"item"}],"confidence":0.9}}}'],
    ['non-finite numeric field', '{"fields":{"total":{"value":1e400,"confidence":0.9}}}'],
    ['nested row cell', '{"fields":{},"rows":[{"description":{"text":"item"}}]}'],
    ['malformed row', '{"fields":{},"rows":[42]}'],
  ] as const)('rejects %s', (_label, payload) => {
    expect(() => presetRunResultFromText(payload, preset)).toThrow(schemaError);
  });

  it('accepts partial {"fields":{}} and reports missing required fields', () => {
    const result = presetRunResultFromText('{"fields":{}}', preset);

    expect(result.json.fields.invoice_number?.value).toBeNull();
    expect(result.json.validationErrors).toBeDefined();
    expect(result.json.validationErrors?.some((msg) => msg.includes('invoice_number'))).toBe(true);
    expect(result.json.validationErrors?.some((msg) => msg.includes('total'))).toBe(true);
  });

  it('accepts a well-formed partial field map without inventing missing keys as schema errors', () => {
    const result = presetRunResultFromText(
      JSON.stringify({
        documentType: 'Invoice',
        summary: 'Partial',
        fields: {
          total: { value: '10.00', confidence: 0.95 },
        },
      }),
      preset,
    );

    expect(result.json.fields.total?.value).toBe('10.00');
    expect(result.json.fields.total?.confidence).toBe(0.95);
    // Other required fields remain validation (not schema) failures.
    expect(result.json.validationErrors?.some((msg) => msg.includes('invoice_number'))).toBe(true);
  });
});
