import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGenerateContent, mockRegionCropper } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
  mockRegionCropper: vi.fn(),
}));

vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');

  return {
    ...actual,
    GoogleGenAI: class {
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

import type { AgentMemory, NormalizedRegion } from './agentTypes';
import { applyMemoryUpdate } from './agentMemory';
import { evaluateAgentCompletion } from './agentSchema';
import { GeminiCostLimitError } from './gemini/requestPolicy';
import {
  AGENT_FUNCTIONS,
  executeAnalyzeDocumentStructure,
  executeExtractFieldsBatch,
  executeReOcrRegion,
} from './agentTools';

function createMemory(documentType = 'invoice'): AgentMemory {
  return {
    sessionId: 'session-1',
    documentName: 'fixture.pdf',
    currentIteration: 1,
    extractedFields: {
      vendor_name: {
        value: 'Northwind Supply Co.',
        confidence: 0.99,
        extractedAt: 100,
      },
      invoice_number: {
        value: 'INV-2026-0142',
        confidence: 0.97,
        extractedAt: 100,
      },
      invoice_date: {
        value: '2026-02-18',
        confidence: 0.96,
        extractedAt: 100,
      },
    },
    processingHistory: [],
    documentAnalysis: {
      pageCount: 1,
      documentType,
      complexity: 'medium',
      specialFeatures: [],
    },
    confidence: 0.97,
    lastUpdated: 100,
  };
}

const totalRegion: NormalizedRegion = {
  page: 1,
  x: 0.68,
  y: 0.72,
  width: 0.2,
  height: 0.08,
  units: 'normalized',
};

describe('agentTools', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockRegionCropper.mockReset();
    mockRegionCropper.mockResolvedValue({
      dataUrl: 'data:image/png;base64,Y3JvcA==',
      mimeType: 'image/png',
      width: 160,
      height: 64,
    });
  });

  it('names the batch entry and field that made a batch invalid', async () => {
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'invoice_number', field_value: 'INV-1', confidence: 0.9 },
        { field_name: 'total_amount', field_value: '$27.00', confidence: 95 },
      ],
    }, '', '', createMemory('invoice'));
    expect(result).toMatchObject({ success: false });
    expect(result.error).toBe(
      'Invalid field entry fields[1] ("total_amount"): Expected a finite confidence between 0 and 1 for "confidence", got 95',
    );
    const unnamed = await executeExtractFieldsBatch({ fields: [{ field_value: 'x', confidence: 0.5 }] }, '', '', createMemory('invoice'));
    expect(unnamed.error).toMatch(/^Invalid field entry fields\[0\]: Expected non-empty string for "field_name"/);
  });

  it('normalizes extracted alias field names to canonical schema names in a batch', async () => {
    const result = await executeExtractFieldsBatch(
      {
        fields: [
          {
            field_name: 'email_address',
            field_value: 'nina@orbitpartners.com',
            confidence: 0.99,
            validation_rule: 'email',
          },
        ],
      },
      '',
      '',
      createMemory('business card'),
    );

    expect(result.success).toBe(true);
    expect(result.memoryUpdate?.extractedFields?.email?.value).toBe('nina@orbitpartners.com');
    expect(result.memoryUpdate?.extractedFields?.email_address).toBeUndefined();
  });

  it('retains prototype-named model fields without treating inherited methods as existing values', async () => {
    const memory = createMemory('unknown');
    const result = await executeExtractFieldsBatch({
      fields: ['constructor', '__proto__', 'toString'].map((name) => ({
        field_name: name, field_value: 'invalid email', confidence: 0.9, validation_rule: 'email',
      })),
    }, '', '', memory);
    expect(result.success).toBe(true);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(Object.getPrototypeOf(memory.extractedFields)).toBe(Object.prototype);
    for (const name of ['constructor', 'proto', 'tostring']) {
      expect(Object.hasOwn(memory.extractedFields, name)).toBe(true);
      expect(memory.extractedFields[name]).toMatchObject({ value: 'invalid email', isValid: false });
    }
  });

  it('stores typed normalized locations for extracted fields', async () => {
    const result = await executeExtractFieldsBatch(
      {
        fields: [
          {
            field_name: 'total_amount',
            field_value: '1471.50',
            confidence: 0.99,
            location: totalRegion,
          },
        ],
      },
      '',
      '',
      createMemory('invoice'),
    );

    expect(result.success).toBe(true);
    expect(result.memoryUpdate?.extractedFields?.total_amount?.location).toEqual(totalRegion);
  });

  it('accepts a valid lower-confidence correction to an invalid field', async () => {
    const memory = createMemory('unknown');
    memory.extractedFields.email = { value: 'invalid', confidence: 0.99, isValid: false };
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: 'email', field_value: 'person@example.com', confidence: 0.8 }],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.email).toMatchObject({
      value: 'person@example.com', confidence: 0.8, isValid: true,
    });
  });

  it('keeps a valid value when a duplicate in the same batch has higher confidence but fails validation', async () => {
    const memory = createMemory('unknown');
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'email', field_value: 'person@example.com', confidence: 0.8 },
        { field_name: 'email', field_value: 'invalid', confidence: 0.99 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.email).toMatchObject({ value: 'person@example.com', isValid: true });
  });

  it('persists arithmetic review results and revalidates them when a related field changes', async () => {
    const memory = createMemory();
    const first = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'total_amount', field_value: '120', confidence: 0.95 },
        { field_name: 'subtotal_amount', field_value: '110', confidence: 0.9 },
        { field_name: 'item_count', field_value: '2', confidence: 0.9 },
        { field_name: 'item_1_amount', field_value: '100', confidence: 0.9 },
        { field_name: 'item_2_amount', field_value: '20', confidence: 0.9 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, first.memoryUpdate);
    expect(memory.extractedFields.subtotal_amount.isValid).toBe(false);
    expect(memory.extractedFields.subtotal_amount.validationMessage).toContain('complete item amounts');
    expect(memory.extractedFields.total_amount.isValid).toBe(true);

    const corrected = await executeExtractFieldsBatch({
      fields: [{ field_name: 'item_2_amount', field_value: '10', confidence: 0.95 }],
    }, '', '', memory);
    applyMemoryUpdate(memory, corrected.memoryUpdate);
    expect(memory.extractedFields.subtotal_amount.isValid).toBe(true);
    expect(memory.extractedFields.subtotal_amount.validationMessage).not.toContain('does not match');
  });

  it('does not invalidate legitimate grand totals or incomplete subtotal evidence', async () => {
    const memory = createMemory();
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'total_amount', field_value: '125', confidence: 0.95 },
        { field_name: 'subtotal_amount', field_value: '100', confidence: 0.95 },
        { field_name: 'tax_amount', field_value: '20', confidence: 0.95 },
        { field_name: 'shipping_amount', field_value: '10', confidence: 0.95 },
        { field_name: 'discount_amount', field_value: '5', confidence: 0.95 },
        { field_name: 'item_1_amount', field_value: '60', confidence: 0.95 },
        { field_name: 'item_1_description', field_value: '2 boxes of 5 parts', confidence: 0.95 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.total_amount.isValid).toBe(true);
    expect(memory.extractedFields.subtotal_amount.isValid).toBe(true);
  });

  it.each([
    ['31/12/2026', true], ['12/31/2026', true], ['31-12-2026 23:59:59', true],
    ['2028-02-29', true], ['2026-02-29', false], ['31/04/2026', false],
    ['2026-01-12 24:00', false], ['2026-01-12 12:60', false],
    ['15.01.2026', true], ['1.5.2026', true], ['31.04.2026', false], ['01.15.2026', false],
    ['1/5/2026', true], ['2026/01/15', true], ['2026-01-15T10:00:00Z', true],
    ['2026-01-15T10:00:00.250+05:30', true], ['2026-01-15T10:00:00+15:00', false],
    ['March 3, 2026', true], ['Mar 3 2026', true], ['3 March 2026', true], ['3rd of March, 2026', true],
    ['03-Mar-2026', true], ['30 February 2026', false], ['Smarch 3, 2026', false], ['15/01/26', false],
  ])('validates real calendar dates consistently: %s', async (value, expected) => {
    const memory = createMemory();
    delete memory.extractedFields.invoice_date;
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: 'invoice_date', field_value: value, confidence: 1 }],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.invoice_date.isValid).toBe(expected);
  });

  it.each([
    ['31/12/2026', '30/12/2026', false],
    ['12/30/2026', '12/31/2026', true],
    ['2026-03-15', '04/03/2026', true],
  ])('cross-checks due dates without guessing numeric date locales', async (invoiceDate, dueDate, expected) => {
    const memory = createMemory();
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'invoice_date', field_value: invoiceDate, confidence: 1 },
        { field_name: 'due_date', field_value: dueDate, confidence: 1 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.due_date.isValid).toBe(expected);
  });

  it('keeps a known-valid value when a higher-confidence candidate fails the cross-reference review', async () => {
    const memory = createMemory();
    memory.extractedFields.invoice_date.isValid = true;
    memory.extractedFields.due_date = { value: '2026-03-20', confidence: 0.9, isValid: true, extractedAt: 100 };
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: 'due_date', field_value: '2026-01-20', confidence: 0.95 }],
    }, '', '', memory);
    expect(result.data).toMatchObject({
      fields: [{ field_name: 'due_date', isValid: false, validationMessage: 'Due date cannot be before invoice date' }],
    });
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.due_date).toMatchObject({ value: '2026-03-20', isValid: true });
  });

  it.each(['due-first', 'invoice-first'])('accepts a self-consistent correction batch whatever its order (%s)', async (order) => {
    const memory = createMemory();
    const seeded = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'invoice_date', field_value: '2026-01-10', confidence: 0.8 },
        { field_name: 'due_date', field_value: '2026-02-10', confidence: 0.8 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, seeded.memoryUpdate);
    const correction = [
      { field_name: 'due_date', field_value: '2025-12-31', confidence: 0.99 },
      { field_name: 'invoice_date', field_value: '2025-12-01', confidence: 0.99 },
    ];
    const result = await executeExtractFieldsBatch({
      fields: order === 'due-first' ? correction : [...correction].reverse(),
    }, '', '', memory);
    expect((result.data as { fields: Array<Record<string, unknown>> }).fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field_name: 'due_date', isValid: true }),
      expect.objectContaining({ field_name: 'invoice_date', isValid: true }),
    ]));
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.invoice_date).toMatchObject({ value: '2025-12-01', isValid: true });
    expect(memory.extractedFields.due_date).toMatchObject({ value: '2025-12-31', isValid: true });
  });

  it('keeps a stored due date when the batch invoice date that would justify a new one is rejected', async () => {
    const memory = createMemory();
    memory.extractedFields.invoice_date = { value: '2026-01-10', confidence: 0.9, isValid: true, extractedAt: 100 };
    memory.extractedFields.due_date = { value: '2026-02-10', confidence: 0.9, isValid: true, extractedAt: 100 };
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'due_date', field_value: '2025-12-31', confidence: 0.99 },
        { field_name: 'invoice_date', field_value: 'see stamp', confidence: 0.99 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.invoice_date).toMatchObject({ value: '2026-01-10', isValid: true });
    expect(memory.extractedFields.due_date).toMatchObject({ value: '2026-02-10', isValid: true });
  });

  it('keeps a known-valid value when the candidate passes its explicit rule but fails the name-based check', async () => {
    const memory = createMemory('unknown');
    const first = await executeExtractFieldsBatch({
      fields: [{ field_name: 'contact_email', field_value: 'a@b.co', confidence: 0.8 }],
    }, '', '', memory);
    applyMemoryUpdate(memory, first.memoryUpdate);
    const second = await executeExtractFieldsBatch({
      fields: [{ field_name: 'contact_email', field_value: 'nope', confidence: 0.99, validation_rule: 'text' }],
    }, '', '', memory);
    applyMemoryUpdate(memory, second.memoryUpdate);
    expect(memory.extractedFields.contact_email).toMatchObject({ value: 'a@b.co', isValid: true });

    const invoice = createMemory();
    invoice.extractedFields.invoice_date.isValid = true;
    const dated = await executeExtractFieldsBatch({
      fields: [{ field_name: 'invoice_date', field_value: 'see stamp', confidence: 0.99, validation_rule: 'Date' }],
    }, '', '', invoice);
    applyMemoryUpdate(invoice, dated.memoryUpdate);
    expect(invoice.extractedFields.invoice_date).toMatchObject({ value: '2026-02-18', isValid: true });
  });

  it.each([
    ['invoice', 'total_amount', 'amount_due', '1,000.00', '400.00'],
    ['receipt', 'transaction_date', 'transaction_time', '2026-01-12', '14:22'],
    ['resume', 'education', 'certifications', 'BSc Industrial Design', 'AWS Solutions Architect'],
  ])('keeps %s fields %s and %s as separate facts', async (documentType, firstName, secondName, firstValue, secondValue) => {
    const memory = createMemory(documentType);
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: firstName, field_value: firstValue, confidence: 0.95 },
        { field_name: secondName, field_value: secondValue, confidence: 0.95 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields[firstName]).toMatchObject({ value: firstValue, isValid: true });
    expect(memory.extractedFields[secondName]).toMatchObject({ value: secondValue, isValid: true });
  });

  it.each([
    ['€ 1.234.567', true], ['150.00-', true], ['1.234,56', true], ['(150.00)', true], ['n/a', false],
  ])('validates printed currency amount %s', async (value, expected) => {
    const memory = createMemory();
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: 'total_amount', field_value: value, confidence: 0.95 }],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.total_amount.isValid).toBe(expected);
  });

  it('completes an invoice whose date is printed day-first with dots', async () => {
    const memory = createMemory();
    delete memory.extractedFields.invoice_date;
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'invoice_date', field_value: '15.01.2026', confidence: 0.98 },
        { field_name: 'customer_name', field_value: 'Acme Logistics', confidence: 0.98 },
        { field_name: 'total_amount', field_value: '1.471,50', confidence: 0.98 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(evaluateAgentCompletion(memory, 0.98, 0.8)).toEqual({
      complete: true, reason: 'confidence-and-coverage-met',
    });
  });

  it.each([
    ['form', 'candidate_name', 'Jordan Lee', undefined],
    ['form', 'candidate_name', 'Jordan Lee', 'text'],
    ['form', 'validated_by', 'Operations', undefined],
    ['form', 'update_reason', 'Address change', undefined],
    ['form', 'mandate_reference', 'MR-2026-01', undefined],
    ['form', 'taxpayer_name', 'Jordan Lee', undefined],
    ['form', 'tax_id', 'pending', undefined],
    ['form', 'phone_type', 'mobile', undefined],
    ['contract', 'liquidated_damages', '$5,000 per day', undefined],
    ['invoice', 'consolidated_total', '1,234.00', undefined],
    ['resume', 'candidate_location', 'Amsterdam', undefined],
  ])('does not read a word inside the %s field name %s as a type', async (documentType, name, value, rule) => {
    const memory = createMemory(documentType);
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: name, field_value: value, confidence: 0.95, ...(rule ? { validation_rule: rule } : {}) }],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields[name]).toMatchObject({ value, isValid: true });
  });

  it.each([
    ['invoice_date', 'next week'], ['due_date', 'on receipt'], ['date_of_birth', 'unknown'],
    ['phone_number', 'call me'], ['contact_email', 'nope'], ['tax_amount', 'n/a'],
  ])('still checks the type of %s by its name', async (name, value) => {
    const memory = createMemory('form');
    memory.extractedFields = {};
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: name, field_value: value, confidence: 0.95, validation_rule: 'text' }],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields[name]).toMatchObject({ value, isValid: false });
  });

  it('stores only the region keys of a model-supplied location', async () => {
    const result = await executeExtractFieldsBatch({
      fields: [{
        field_name: 'invoice_number', field_value: 'INV-1', confidence: 0.99,
        location: { ...totalRegion, label: 'top right' },
      }],
    }, '', '', createMemory());
    expect(result.success).toBe(true);
    expect(result.memoryUpdate?.extractedFields?.invoice_number?.location).toStrictEqual(totalRegion);
    expect(result.data).toMatchObject({ fields: [{ location: totalRegion }] });
    expect((result.data as { fields: Array<{ location: object }> }).fields[0].location).toStrictEqual(totalRegion);
  });

  it('keeps re-OCR fields whose crop-relative location is not a valid page region', async () => {
    const controller = new AbortController();
    const result = await executeReOcrRegion(
      { region: { ...totalRegion, rotation: 0 }, focus: 'invoice total' },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory(),
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash-lite',
        abortSignal: controller.signal,
        regionCropper: mockRegionCropper,
        regionStructuredExtractor: () => Promise.resolve({
          fields: [{
            field_name: 'total_amount', field_value: '1471.50', confidence: 0.95,
            location: { page: 1, x: 0.1, y: 0, width: 0.95, height: 1, units: 'normalized' },
          }],
        }),
      },
    );
    expect(result.success).toBe(true);
    expect(mockRegionCropper).toHaveBeenCalledWith(
      'data:application/pdf;base64,ZmFrZQ==', 'application/pdf', totalRegion, controller.signal,
    );
    expect(result.memoryUpdate?.extractedFields?.total_amount).toMatchObject({ value: '1471.50', isValid: true });
    expect(result.memoryUpdate?.extractedFields?.total_amount?.location).toStrictEqual(totalRegion);
    expect((result.data as { region: object }).region).toStrictEqual(totalRegion);
  });

  it('declares and carries layout features and special features', async () => {
    const analyze = AGENT_FUNCTIONS.find((declaration) => declaration.name === 'analyze_document_structure');
    const schema = analyze?.parametersJsonSchema as { properties: { layout_analysis: { properties: Record<string, unknown> } } };
    expect(Object.keys(schema.properties.layout_analysis.properties)).toEqual(['features', 'specialFeatures']);

    const result = await executeAnalyzeDocumentStructure({
      document_type: 'invoice',
      layout_analysis: {
        features: ['header', 'two columns', 'line-item table', 'totals box', 'footer', 'logo'],
        specialFeatures: ['handwriting', 7],
      },
      extraction_strategy: 'form-based',
      confidence: 0.9,
    }, '', '', createMemory('unknown'));
    expect(result.memoryUpdate?.documentAnalysis).toMatchObject({
      complexity: 'medium', specialFeatures: ['handwriting'],
    });
  });

  it('does not assume an unextracted subtotal or tax is zero', async () => {
    const memory = createMemory();
    const result = await executeExtractFieldsBatch({
      fields: [
        { field_name: 'total_amount', field_value: '120', confidence: 0.95 },
        { field_name: 'tax_amount', field_value: '20', confidence: 0.9 },
      ],
    }, '', '', memory);
    applyMemoryUpdate(memory, result.memoryUpdate);
    expect(memory.extractedFields.total_amount.isValid).toBe(true);
  });

  it.each([-0.1, 1.1, Infinity, NaN])('rejects invalid field confidence %s', async (confidence) => {
    const result = await executeExtractFieldsBatch({
      fields: [{ field_name: 'note', field_value: 'hello', confidence }],
    }, '', '', createMemory());
    expect(result.success).toBe(false);
    expect(result.memoryUpdate).toBeUndefined();
  });

  it('propagates region cost-limit errors to the agent loop', async () => {
    const failure = new GeminiCostLimitError(0.01);
    await expect(executeReOcrRegion(
      { region: totalRegion, focus: 'invoice total' },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory(),
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash-lite',
        regionCropper: mockRegionCropper,
        regionStructuredExtractor: () => Promise.reject(failure),
      },
    )).rejects.toBe(failure);
  });

  it('returns schema guidance from analyze_document_structure', async () => {
    const result = await executeAnalyzeDocumentStructure(
      {
        document_type: 'Business_Card',
        layout_analysis: { description: 'front and back' },
        extraction_strategy: 'form-based',
        confidence: 0.96,
      },
      '',
      '',
      createMemory('unknown'),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      document_type: 'business card',
      required_fields: ['full_name', 'company_name', 'email'],
    });
  });

  it('returns readiness details for incomplete batches', async () => {
    const result = await executeExtractFieldsBatch(
      {
        fields: [
          {
            field_name: 'customer_name',
            field_value: 'Acme Logistics',
            confidence: 0.98,
          },
        ],
      },
      '',
      '',
      createMemory('invoice'),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      fieldCount: 1,
      missingRequiredFields: ['total_amount'],
    });
  });

  it('accepts date-time values for date validation rules', async () => {
    const result = await executeExtractFieldsBatch(
      {
        fields: [
          {
            field_name: 'transaction_date',
            field_value: '2026-01-12 14:22',
            confidence: 0.99,
            validation_rule: 'date',
          },
        ],
      },
      '',
      '',
      createMemory('receipt'),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      fieldCount: 1,
    });
    expect(result.memoryUpdate?.extractedFields?.transaction_date?.isValid).toBe(true);
  });

  it('returns parsed field candidates directly from re_ocr_region and updates memory', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({
        fields: [
          {
            field_name: 'total_amount',
            field_value: '1471.50',
            confidence: 0.99,
            validation_rule: 'currency',
            location: totalRegion,
          },
        ],
      }),
      candidates: [{ finishReason: 'STOP' }],
    });

    const result = await executeReOcrRegion(
      {
        region: totalRegion,
        focus: 'invoice total',
        target_fields: ['total_amount'],
        confidence_threshold: 0.8,
      },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory('invoice'),
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash-lite',
        thinkingConfig: {
          level: 'MINIMAL',
          includeThoughts: false,
        },
        regionCropper: mockRegionCropper,
      },
    );

    expect(mockRegionCropper).toHaveBeenCalledWith(
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      totalRegion,
      undefined,
    );
    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        responseMimeType: 'application/json',
        responseJsonSchema: expect.objectContaining({
          type: 'object',
          required: ['fields'],
        }) as unknown,
      }) as unknown,
    }));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      fieldCount: 1,
      fieldCandidates: [
        {
          field_name: 'total_amount',
          field_value: '1471.50',
          location: totalRegion,
        },
      ],
    });
    expect(result.memoryUpdate?.extractedFields?.total_amount?.value).toBe('1471.50');
    expect(result.memoryUpdate?.extractedFields?.total_amount?.location).toEqual(totalRegion);
  });

  it('does not accept truncated re-OCR JSON as a successful tool result', async () => {
    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify({ fields: [] }),
      candidates: [{ finishReason: 'MAX_TOKENS' }],
    });

    const result = await executeReOcrRegion(
      { region: totalRegion, focus: 'invoice total' },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory('invoice'),
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash-lite',
        regionCropper: mockRegionCropper,
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/incomplete output/i);
  });

  it('fails closed when re_ocr_region is called without valid normalized coordinates', async () => {
    const result = await executeReOcrRegion(
      {
        region: 'top right total',
        focus: 'invoice total',
      },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory('invoice'),
      {
        apiKey: 'test-key',
        model: 'gemini-3.5-flash-lite',
        regionCropper: mockRegionCropper,
      },
    );

    expect(mockRegionCropper).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain('"region" must be a normalized region object');
  });

  it('fails closed when region refinement is not configured for the runtime', async () => {
    const result = await executeReOcrRegion(
      { region: totalRegion, focus: 'invoice total' },
      'data:application/pdf;base64,ZmFrZQ==',
      'application/pdf',
      createMemory('invoice'),
      { apiKey: 'test-key', model: 'gemini-3.5-flash-lite' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Region refinement is not configured');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
