import { describe, expect, it } from 'vitest';

import {
  evaluateAgentCompletion,
  getAgentDocumentSchema,
  getAgentReadiness,
  normalizeAgentDocumentType,
  normalizeAgentFieldName,
} from './agentSchema';
import type { AgentMemory } from './agentTypes';

const snapshot = (
  documentType: string,
  fields: AgentMemory['extractedFields'],
): Pick<AgentMemory, 'documentAnalysis' | 'extractedFields'> => ({
  documentAnalysis: { pageCount: 1, documentType, complexity: 'medium', specialFeatures: [] },
  extractedFields: fields,
});

describe('getAgentReadiness — confidence clamping (A-10)', () => {
  it('clamps out-of-range/NaN confidences into [0, 1]', () => {
    const readiness = getAgentReadiness(snapshot('unknown', {
      a: { value: 'x', confidence: 1.8 },
      b: { value: 'y', confidence: Number.NaN },
    }));
    expect(readiness.averageConfidence).toBeLessThanOrEqual(1);
    expect(readiness.averageConfidence).toBeGreaterThanOrEqual(0);
  });

  it('counts only fields not flagged invalid as valid', () => {
    const readiness = getAgentReadiness(snapshot('unknown', {
      a: { value: 'x', confidence: 0.9, isValid: true },
      b: { value: 'y', confidence: 0.9, isValid: false },
    }));
    expect(readiness.fieldCount).toBe(2);
    expect(readiness.validFieldCount).toBe(1);
  });
});

describe('evaluateAgentCompletion — runtime stop decision (C-03)', () => {
  it('is not complete when confidence is below the threshold', () => {
    const result = evaluateAgentCompletion(
      snapshot('unknown', { note: { value: 'x', confidence: 0.5, isValid: true } }),
      0.5,
      0.8,
    );
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('below-confidence-threshold');
  });

  it('is not complete when required schema fields are missing', () => {
    const result = evaluateAgentCompletion(
      snapshot('invoice', { invoice_number: { value: 'INV-1', confidence: 0.99, isValid: true } }),
      0.99,
      0.8,
    );
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('missing-required-fields');
  });

  it('is not complete with zero valid fields', () => {
    const result = evaluateAgentCompletion(snapshot('unknown', {}), 0.99, 0.8);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('no-fields');
  });

  it('does not count an invalid required field as completed coverage', () => {
    const data = snapshot('resume', {
      full_name: { value: 'Example Person', confidence: 0.99, isValid: true },
      email: { value: 'invalid', confidence: 0.99, isValid: false },
    });
    expect(getAgentReadiness(data).missingRequiredFields).toEqual(['email']);
    expect(evaluateAgentCompletion(data, 0.99, 0.8)).toEqual({
      complete: false, reason: 'missing-required-fields',
    });
  });

  it('is complete when an unknown-schema doc has a valid field above the threshold', () => {
    const result = evaluateAgentCompletion(
      snapshot('unknown', { note: { value: 'x', confidence: 0.9, isValid: true } }),
      0.9,
      0.8,
    );
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('confidence-and-coverage-met');
  });
});

describe('agentSchema', () => {
  it('normalizes known document types', () => {
    expect(normalizeAgentDocumentType('Business_Card')).toBe('business card');
    expect(normalizeAgentDocumentType('CV')).toBe('resume');
    expect(normalizeAgentDocumentType('Invoice')).toBe('invoice');
  });

  it('maps alias field names to canonical schema names', () => {
    expect(normalizeAgentFieldName('business card', 'email_address')).toBe('email');
    expect(normalizeAgentFieldName('invoice', 'grand-total')).toBe('total_amount');
    expect(normalizeAgentFieldName('resume', 'candidate_name')).toBe('full_name');
  });

  it.each([
    ['constructor', 'constructor'], ['__proto__', 'proto'], ['toString', 'tostring'],
  ])('treats prototype name %s as ordinary text', (input, normalized) => {
    expect(normalizeAgentDocumentType(input)).toBe(normalized);
    expect(getAgentDocumentSchema(input)).toBeNull();
    expect(normalizeAgentFieldName('invoice', input)).toBe(normalized);
    expect(normalizeAgentFieldName(input, input)).toBe(normalized);
  });

  it('reports missing required fields for schema-backed document types', () => {
    const readiness = getAgentReadiness({
      documentAnalysis: {
        pageCount: 1,
        documentType: 'invoice',
        complexity: 'medium',
        specialFeatures: [],
      },
      extractedFields: {
        vendor_name: { value: 'Northwind Supply Co.', confidence: 0.98 },
        invoice_number: { value: 'INV-2026-0142', confidence: 0.97 },
        invoice_date: { value: '2026-02-18', confidence: 0.95 },
        total_amount: { value: '1471.50', confidence: 0.99 },
      },
    });

    expect(getAgentDocumentSchema('invoice')?.requiredFields).toContain('customer_name');
    expect(readiness.missingRequiredFields).toEqual(['customer_name']);
    expect(readiness.requiredCoverage).toBeCloseTo(0.8);
    expect(readiness.averageConfidence).toBeGreaterThan(0.9);
  });
});
