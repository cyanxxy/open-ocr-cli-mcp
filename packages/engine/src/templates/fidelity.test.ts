import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent: mockGenerateContent, generateContentStream: vi.fn() };
    },
  };
});

import { OcrError } from '../gemini/types';
import {
  DEFAULT_TEMPLATE_MAX_TOKENS,
  buildPresetCsv,
  buildPresetMarkdown,
  normalizeFieldValue,
  presetRunResultFromText,
  runExtractionPreset,
} from './engine';
import { getExtractionPreset } from './presets';

function currency(value: unknown, extra: { currency?: string } = {}): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];
  return { value: normalizeFieldValue(value, 'currency', { field: 'total', warnings, ...extra }), warnings };
}

function presetText(fields: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ documentType: 'Doc', summary: 's', fields, warnings: [], ...extra });
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

afterEach(() => mockGenerateContent.mockReset());

describe('money parsing keeps sign and magnitude', () => {
  it.each([
    ['USD -5.00', '-5.00'],
    ['-$5.00', '-5.00'],
    ['$-5.00', '-5.00'],
    ['5.00-', '-5.00'],
    ['(27.00)', '-27.00'],
    ['$(27.00)', '-27.00'],
    ['\u22125.00', '-5.00'],
    ['EUR 1.234,56', '1234.56'],
    ['1 234,56 €', '1234.56'],
    ["CHF 1'234.50", '1234.50'],
    ['0.125', '0.125'],
  ])('reads %s as %s', (raw, expected) => {
    expect(currency(raw).value).toBe(expected);
  });

  it.each([
    ['Rs.500', '500.00'],
    ['Rs 500', '500.00'],
    ['rs.1,500.00', '1500.00'],
    ['Re.1', '1.00'],
    ['Fr.25', '25.00'],
    ['SFr.25.50', '25.50'],
    ['Bs.100', '100.00'],
    ['S/.100', '100.00'],
    ['B/.12.50', '12.50'],
    ['Kr.75', '75.00'],
    ['kr.75', '75.00'],
    ['Dhs.250', '250.00'],
    ['Ksh.1,000', '1000.00'],
    ['Rs.-500', '-500.00'],
  ])('reads the currency abbreviation in %s as a word, not a decimal point (%s)', (raw, expected) => {
    const { value, warnings } = currency(raw);
    expect(value).toBe(expected);
    expect(warnings.filter((warning) => !/three digits/.test(warning))).toEqual([]);
  });

  it.each(['$.50', '.5', '-.5', '€,50'])('still reads a leading separator after a symbol or sign as a decimal point (%s)', (raw) => {
    expect(Math.abs(Number(currency(raw).value))).toBeLessThan(1);
  });

  it.each(['No.5', 'USD.50', 'Rs,500', 'abc.25'])('keeps text and warns when a separator follows letters it does not know (%s)', (raw) => {
    const { value, warnings } = currency(raw);
    expect(value).toBe(raw);
    expect(warnings[0]).toMatch(/separator directly after letters/);
    const numberWarnings: string[] = [];
    expect(normalizeFieldValue(raw, 'number', { field: 'qty', warnings: numberWarnings })).toBe(raw);
    expect(numberWarnings[0]).toMatch(/separator directly after letters/);
  });

  it.each([
    ['€1.234', '1234.00'],
    ['(27.00)', '-27.00'],
    ['USD -5.00', '-5.00'],
    ['1.234,56', '1234.56'],
    ['1,234.56', '1234.56'],
  ])('keeps reading %s as %s', (raw, expected) => {
    expect(currency(raw).value).toBe(expected);
  });

  it('reads a single separator before three digits as grouping, and warns', () => {
    const { value, warnings } = currency('€1.234');
    expect(value).toBe('1234.00');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/"€1\.234".*ambiguous.*thousands separator.*decimal separator the value is 1\.234/);
    expect(currency('1,234').warnings).toHaveLength(1);
  });

  it('reads it as a three-decimal amount for BHD/KWD/OMR/JOD/TND/LYD/IQD, and warns', () => {
    const inline = currency('KWD 1.234');
    expect(inline.value).toBe('1.234');
    expect(inline.warnings[0]).toMatch(/decimal separator; KWD uses three decimals.*thousands separator the value is 1234/);
    expect(currency('1.234', { currency: 'BHD' }).value).toBe('1.234');
    expect(currency('1.500', { currency: 'OMR' }).value).toBe('1.500');
    expect(currency(1.234, { currency: 'JOD' }).value).toBe('1.234');
  });

  it('never guesses a magnitude it cannot read: keeps the text and warns', () => {
    for (const raw of ['3 @ 5.00', '1,23,4', '12 34']) {
      const { value, warnings } = currency(raw);
      expect(value).toBe(raw);
      expect(warnings[0]).toMatch(/could not be read as a single amount/);
    }
  });

  it('keeps the long-standing reading for plain numbers but warns on the ambiguous case', () => {
    const warnings: string[] = [];
    expect(normalizeFieldValue('1,234', 'number', { field: 'qty', warnings })).toBe(1234);
    expect(normalizeFieldValue('1.234', 'number', { field: 'qty', warnings })).toBe(1.234);
    expect(normalizeFieldValue('(3)', 'number')).toBe(-3);
    expect(warnings).toHaveLength(2);
  });

  it('uses the document currency field when the amount itself names none', () => {
    const preset = getExtractionPreset('invoice');
    const result = presetRunResultFromText(presetText({
      invoice_number: { value: 'INV-1', confidence: 0.9 },
      invoice_date: { value: '2026-02-18', confidence: 0.9 },
      vendor_name: { value: 'ACME', confidence: 0.9 },
      currency: { value: 'KWD', confidence: 0.9 },
      total: { value: '1.234', confidence: 0.9 },
    }, { rows: [{ description: 'x', quantity: '1', unit_price: '1.234', line_total: '1.234' }] }), preset);
    expect(result.json.fields.total.value).toBe('1.234');
    expect(result.json.validationWarnings?.join('\n')).toMatch(/KWD uses three decimals/);
  });
});

describe('required-field and typed-field validation', () => {
  it('reports missing required fields as validation errors', () => {
    const result = presetRunResultFromText(presetText({
      invoice_number: { value: null, confidence: 0 },
      vendor_name: { value: 'ACME', confidence: 0.9 },
    }, { rows: [] }), getExtractionPreset('invoice'));
    expect(result.json.validationErrors).toEqual(expect.arrayContaining([
      'Required field "invoice_number" is missing or empty.',
      'Required field "invoice_date" is missing or empty.',
      'Required field "total" is missing or empty.',
    ]));
  });

  it('warns about non-ISO dates and malformed emails but keeps the values', () => {
    const result = presetRunResultFromText(presetText({
      full_name: { value: 'Jordan', confidence: 0.9 },
      email: { value: 'jordan at example', confidence: 0.9 },
    }), getExtractionPreset('resume'));
    expect(result.json.fields.email.value).toBe('jordan at example');
    expect(result.json.validationWarnings).toContain('Field "email": "jordan at example" does not look like an email address.');

    const receipt = presetRunResultFromText(presetText({
      merchant_name: { value: 'Shop', confidence: 0.9 },
      transaction_date: { value: '12/01/26', confidence: 0.9 },
      total: { value: '1.00', confidence: 0.9 },
    }, { rows: [{ item: 'a', quantity: '1', price: '1.00' }] }), getExtractionPreset('receipt'));
    expect(receipt.json.fields.transaction_date.value).toBe('12/01/26');
    expect(receipt.json.validationWarnings?.[0]).toMatch(/"12\/01\/26" is not an ISO 8601 date/);

    const invalidCalendar = presetRunResultFromText(presetText({
      merchant_name: { value: 'Shop', confidence: 0.9 },
      transaction_date: { value: '2026-02-30', confidence: 0.9 },
      total: { value: '1.00', confidence: 0.9 },
    }, { rows: [{ item: 'a', quantity: '1', price: '1.00' }] }), getExtractionPreset('receipt'));
    expect(invalidCalendar.json.validationWarnings?.[0]).toMatch(/not an ISO 8601 date/);
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'file:///etc/passwd'])(
    'drops a non-http(s) URL (%s) to null with a warning',
    (website) => {
      const result = presetRunResultFromText(presetText({
        full_name: { value: 'Nina', confidence: 0.9 },
        company: { value: 'Orbit', confidence: 0.9 },
        website: { value: website, confidence: 0.9 },
      }), getExtractionPreset('business-card'));
      expect(result.json.fields.website).toMatchObject({ value: null, confidence: 0 });
      expect(result.json.validationWarnings?.join('\n')).toMatch(/only http and https URLs are kept/);
      expect(result.markdown).toContain('| website | Not found | 0% |');
    },
  );

  it.each([
    'javascript:1;alert(document.cookie)',
    'javascript:80',
    'JaVaScRiPt:1;alert(1)',
    'vbscript:1;msgbox(1)',
    'VBScript:msgbox(1)',
    'data:1,<script>alert(1)</script>',
    'DATA:text/html;base64,PHNjcmlwdD4=',
    ' javascript:alert(1)',
    'java\nscript:alert(1)',
    'java\u0000script:alert(1)',
    'jav ascript:alert(1)',
    'ht\ttp://evil.example',
    'mailto:a@b.example',
  ])('drops a non-http(s) or disguised scheme (%j) to null with a warning', (website) => {
    const result = presetRunResultFromText(presetText({
      full_name: { value: 'Nina', confidence: 0.9 },
      company: { value: 'Orbit', confidence: 0.9 },
      website: { value: website, confidence: 0.9 },
    }), getExtractionPreset('business-card'));
    expect(result.json.fields.website).toMatchObject({ value: null, confidence: 0 });
    expect(result.json.validationWarnings?.join('\n')).toMatch(/the value was set to null/);
  });

  it('names the scheme of a host:port look-alike that is really a scheme', () => {
    const result = presetRunResultFromText(presetText({
      full_name: { value: 'Nina', confidence: 0.9 },
      company: { value: 'Orbit', confidence: 0.9 },
      website: { value: 'javascript:1;alert(document.cookie)', confidence: 0.9 },
    }), getExtractionPreset('business-card'));
    expect(result.json.validationWarnings).toContain(
      'Field "website": "javascript:1;alert(document.cookie)" uses the "javascript:" scheme; only http and https URLs are kept, so the value was set to null.',
    );
  });

  it.each(['see our website', '12345', 'orbit', 'https://', 'http://exa mple.com', 'user:pass@orbit.example'])(
    'drops text that is not an http(s) URL or real host (%j) to null with a warning',
    (website) => {
      const result = presetRunResultFromText(presetText({
        full_name: { value: 'Nina', confidence: 0.9 },
        company: { value: 'Orbit', confidence: 0.9 },
        website: { value: website, confidence: 0.9 },
      }), getExtractionPreset('business-card'));
      expect(result.json.fields.website).toMatchObject({ value: null, confidence: 0 });
      expect(result.json.validationWarnings?.join('\n')).toMatch(/set to null/);
    },
  );

  it.each([
    'https://orbit.example',
    'HTTPS://Orbit.Example/Path?q=1',
    'http://localhost:3000/x',
    'orbitpartners.com',
    'www.orbit.example:8080/x',
    'localhost:3000',
    '192.168.1.10:8080/admin',
    'xn--bcher-kva.example/path',
    'bücher.example',
  ])('keeps an ordinary website (%s)', (website) => {
    const result = presetRunResultFromText(presetText({
      full_name: { value: 'Nina', confidence: 0.9 },
      company: { value: 'Orbit', confidence: 0.9 },
      website: { value: website, confidence: 0.9 },
    }), getExtractionPreset('business-card'));
    expect(result.json.fields.website.value).toBe(website);
    expect(result.json.validationWarnings).toBeUndefined();
  });
});

describe('unknown keys and empty tables', () => {
  const receipt = getExtractionPreset('receipt');
  const baseFields = {
    merchant_name: { value: 'Shop', confidence: 0.9 },
    transaction_date: { value: '2026-01-12', confidence: 0.9 },
    total: { value: '27.00', confidence: 0.9 },
  };

  it('warns about field keys the preset does not define', () => {
    const result = presetRunResultFromText(presetText({ ...baseFields, bogus_extra: { value: 'x', confidence: 0.5 } }, {
      rows: [{ item: 'a', quantity: '1', price: '1' }],
    }), receipt);
    expect(result.json.fields).not.toHaveProperty('bogus_extra');
    expect(result.json.validationWarnings).toContain('Ignored field(s) the "receipt" preset does not define: "bogus_extra".');
  });

  it('warns about row columns dropped from CSV and Markdown', () => {
    const result = presetRunResultFromText(presetText(baseFields, {
      rows: [{ item: 'a', quantity: '1', price: '1' }, { item: 'b', quantity: '2', price: '2', sku: 'S-1' }],
    }), receipt);
    expect(result.csv).not.toContain('S-1');
    expect(result.json.rows?.[1]).toHaveProperty('sku', 'S-1');
    expect(result.json.validationWarnings?.join('\n')).toMatch(/omitted from CSV and Markdown: "sku" \(first in row 2\)/);
  });

  it('emits a header-only CSV with a warning when a fixed-column table has no rows', () => {
    const result = presetRunResultFromText(presetText(baseFields, { rows: [] }), receipt);
    expect(result.csv).toBe('item,quantity,price');
    expect(result.json.validationWarnings).toContain('No line-item rows were extracted; CSV output contains only the header row.');
    expect(result.json.validationErrors).toBeUndefined();
    expect(result.markdown).toContain('## Validation warnings');
  });

  it('still has no CSV for record presets or column-less tables without rows', () => {
    const resume = getExtractionPreset('resume');
    expect(buildPresetCsv({ presetId: 'resume', documentType: 'r', summary: 's', fields: {} }, resume)).toBeUndefined();
    const columnless = { ...receipt, tableColumns: undefined };
    expect(buildPresetCsv({ presetId: 'receipt', documentType: 'r', summary: 's', fields: {} }, columnless)).toBeUndefined();
    expect(buildPresetMarkdown({ presetId: 'receipt', documentType: 'r', summary: 's', fields: {} }, columnless)).not.toContain('## Rows');
  });
});

describe('template schema errors name the failing path', () => {
  const card = getExtractionPreset('business-card');

  it.each([
    [{ full_name: { value: 'Nina', confidence: 1.5 } }, 'fields.full_name.confidence must be a number from 0 to 1 (got 1.5)'],
    [{ full_name: { value: 'Nina', confidence: 'high' } }, 'fields.full_name.confidence must be a number from 0 to 1 (got "high")'],
    [{ full_name: { value: 'Nina' } }, 'fields.full_name.confidence must be a number from 0 to 1 (got a undefined)'],
    [{ full_name: 'Nina' }, 'fields.full_name must be an object with "value" and "confidence" (got "Nina")'],
    [{ full_name: { value: { first: 'N' }, confidence: 0.9 } }, 'fields.full_name.value must be a string, finite number, or boolean (got a object)'],
    [{ full_name: { value: ['a', 2], confidence: 0.9 } }, 'fields.full_name.value[1] must be a string (got 2)'],
  ])('reports %j', (fields, message) => {
    const error = caught(() => presetRunResultFromText(presetText(fields), card));
    expect(error).toBeInstanceOf(OcrError);
    expect(error).toMatchObject({ type: 'OUTPUT_INVALID' });
    expect((error as Error).message).toContain(message);
  });

  it('names a bad row cell', () => {
    const error = caught(() => presetRunResultFromText(presetText({}, { rows: [{ item: 'a' }, { item: { x: 1 } }] }), getExtractionPreset('receipt')));
    expect((error as Error).message).toContain('rows[1].item must be a string, finite number, or boolean');
  });

  it('coerces a numeric-string confidence and clamps a near-range one, each with a warning', () => {
    const result = presetRunResultFromText(presetText({
      full_name: { value: 'Nina', confidence: '0.9' },
      company: { value: 'Orbit', confidence: 1.02 },
    }), card);
    expect(result.json.fields.full_name.confidence).toBe(0.9);
    expect(result.json.fields.company.confidence).toBe(1);
    expect(result.json.validationWarnings).toEqual([
      'Field "full_name": confidence was the string "0.9"; read as 0.9.',
      'Field "company": confidence 1.02 was outside 0-1; clamped to 1.',
    ]);
  });
});

describe('tolerant JSON in template mode', () => {
  it('chooses the first balanced object that parses, ignoring braces in prose and strings', () => {
    const payload = presetText({ full_name: { value: 'Nina {the} }', confidence: 0.9 } });
    const result = presetRunResultFromText(`Note {not json}. Answer: ${payload} trailing } brace`, getExtractionPreset('business-card'));
    expect(result.json.fields.full_name.value).toBe('Nina {the} }');
  });
});

describe('template max tokens', () => {
  it('defaults to 16384 and honours an explicit maxTokens', async () => {
    mockGenerateContent.mockResolvedValue({
      text: presetText({ full_name: { value: 'Nina', confidence: 0.9 }, company: { value: 'Orbit', confidence: 0.9 } }),
      candidates: [{ finishReason: 'STOP' }],
    });
    const config = { apiKey: 'k', model: 'gemini-3.5-flash-lite' as const, thinkingConfig: { level: 'MINIMAL' as const, includeThoughts: false } };
    const card = getExtractionPreset('business-card');
    await runExtractionPreset('data:image/png;base64,AA==', 'image/png', config, card);
    await runExtractionPreset('data:image/png;base64,AA==', 'image/png', config, card, { maxTokens: 4096 });
    const tokens = mockGenerateContent.mock.calls.map((call) => (call[0] as { config: { maxOutputTokens: number } }).config.maxOutputTokens);
    expect(tokens).toEqual([DEFAULT_TEMPLATE_MAX_TOKENS, 4096]);
    expect(DEFAULT_TEMPLATE_MAX_TOKENS).toBe(16384);
  });
});
