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
import { GeminiCostLimitError } from './gemini/requestPolicy';
import {
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
        model: 'gemini-3-flash-preview',
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
        model: 'gemini-3-flash-preview',
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
        model: 'gemini-3-flash-preview',
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
        model: 'gemini-3-flash-preview',
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
      { apiKey: 'test-key', model: 'gemini-3-flash-preview' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Region refinement is not configured');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
