import { describe, expect, it } from 'vitest';

import { applyMemoryUpdate, createInitialMemory, mergeField, shouldReplaceField } from './agentMemory';
import type { AgentMemory } from './agentTypes';

type FieldData = AgentMemory['extractedFields'][string];

const field = (overrides: Partial<FieldData>): FieldData => ({
  value: 'x',
  confidence: 0.5,
  ...overrides,
});

describe('agentMemory merge ordering (A-13)', () => {
  it('never lets an invalid value overwrite a valid one, even at higher confidence', () => {
    const existing = field({ value: 'GOOD', confidence: 0.6, isValid: true });
    const incoming = field({ value: 'BAD', confidence: 0.99, isValid: false });
    expect(shouldReplaceField(existing, incoming)).toBe(false);
    expect(mergeField(existing, incoming).value).toBe('GOOD');
  });

  it('prefers a valid value over a higher-confidence invalid one in either direction', () => {
    const invalid = field({ value: 'BAD', confidence: 0.99, isValid: false });
    const valid = field({ value: 'GOOD', confidence: 0.4, isValid: true });
    expect(shouldReplaceField(invalid, valid)).toBe(true);
    expect(mergeField(invalid, valid).value).toBe('GOOD');
  });

  it('falls back to confidence then recency when validity is equal', () => {
    const a = field({ value: 'A', confidence: 0.5, isValid: true, extractedAt: 100 });
    const b = field({ value: 'B', confidence: 0.9, isValid: true, extractedAt: 50 });
    expect(mergeField(a, b).value).toBe('B'); // higher confidence wins

    const c = field({ value: 'C', confidence: 0.7, isValid: true, extractedAt: 10 });
    const d = field({ value: 'D', confidence: 0.7, isValid: true, extractedAt: 20 });
    expect(mergeField(c, d).value).toBe('D'); // newer wins on a confidence tie
  });

  it('preserves a previously-known region when the winning value omits one', () => {
    const region = { page: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1, units: 'normalized' as const };
    const existing = field({ value: 'OLD', confidence: 0.4, isValid: true, location: region });
    const incoming = field({ value: 'NEW', confidence: 0.95, isValid: true });
    const merged = mergeField(existing, incoming);
    expect(merged.value).toBe('NEW');
    expect(merged.location).toEqual(region);
  });
});

function createMemory(): AgentMemory {
  return {
    sessionId: 'session-1',
    documentName: 'invoice.pdf',
    currentIteration: 1,
    extractedFields: {
      invoice_number: {
        value: 'INV-1',
        confidence: 0.8,
      },
    },
    processingHistory: [],
    documentAnalysis: {
      pageCount: 1,
      documentType: 'invoice',
      complexity: 'medium',
      specialFeatures: [],
    },
    confidence: 0.8,
    lastUpdated: 100,
  };
}

describe('applyMemoryUpdate', () => {
  it('retains direct prototype-named fields as own data properties without changing the prototype', () => {
    const memory = createInitialMemory('s', 'doc.pdf');
    const names = ['constructor', '__proto__', 'toString'];
    const fields = Object.fromEntries(names.map((name) => [name, {
      value: name, confidence: 0.9, isValid: false,
    }]));
    applyMemoryUpdate(memory, { extractedFields: fields });
    expect(Object.getPrototypeOf(memory.extractedFields)).toBe(Object.prototype);
    expect(Object.keys(memory.extractedFields)).toEqual(names);
    for (const name of names) {
      expect(Object.hasOwn(memory.extractedFields, name)).toBe(true);
      expect(memory.extractedFields[name]).toEqual(fields[name]);
    }
    expect(JSON.parse(JSON.stringify(memory.extractedFields)) as unknown).toEqual(fields);
  });

  it('inserts new fields and merges colliding ones by the deterministic ordering', () => {
    const memory = createInitialMemory('s', 'doc.pdf');
    memory.extractedFields.total = field({ value: '10', confidence: 0.5, isValid: true });

    applyMemoryUpdate(memory, {
      extractedFields: {
        total: field({ value: '99', confidence: 0.4, isValid: false }), // invalid -> rejected
        vendor: field({ value: 'Acme', confidence: 0.8, isValid: true }), // new -> inserted
      },
      confidence: 0.7,
    });

    expect(memory.extractedFields.total?.value).toBe('10');
    expect(memory.extractedFields.vendor?.value).toBe('Acme');
    expect(memory.confidence).toBe(0.7);
  });

  it('merges extracted fields, document analysis, and history items', () => {
    const memory = createMemory();

    applyMemoryUpdate(memory, {
      extractedFields: {
        total: {
          value: '1471.50',
          confidence: 0.95,
        },
      },
      documentAnalysis: {
        pageCount: 2,
        specialFeatures: ['table'],
      },
      confidence: 0.91,
      lastUpdated: 200,
      processingHistoryItem: {
        type: 'result',
        content: 'Applied update',
        timestamp: 123,
      },
    });

    expect(memory.extractedFields.total?.value).toBe('1471.50');
    expect(memory.documentAnalysis.pageCount).toBe(2);
    expect(memory.documentAnalysis.specialFeatures).toEqual(['table']);
    expect(memory.confidence).toBe(0.91);
    expect(memory.lastUpdated).toBe(200);
    expect(memory.processingHistory).toHaveLength(1);
  });

  it('does nothing when no update is provided', () => {
    const memory = createMemory();

    applyMemoryUpdate(memory);

    expect(memory.extractedFields.invoice_number?.value).toBe('INV-1');
    expect(memory.processingHistory).toHaveLength(0);
  });

  it('keeps the higher-confidence version of a field when updates collide', () => {
    const memory = createMemory();

    applyMemoryUpdate(memory, {
      extractedFields: {
        invoice_number: {
          value: 'INV-1-low',
          confidence: 0.4,
          extractedAt: 200,
        },
      },
    });

    expect(memory.extractedFields.invoice_number?.value).toBe('INV-1');

    applyMemoryUpdate(memory, {
      extractedFields: {
        invoice_number: {
          value: 'INV-1-final',
          confidence: 0.95,
          extractedAt: 300,
        },
      },
    });

    expect(memory.extractedFields.invoice_number?.value).toBe('INV-1-final');
    expect(memory.extractedFields.invoice_number?.confidence).toBe(0.95);
  });
});
