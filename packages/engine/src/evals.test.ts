import { describe, expect, it } from 'vitest';
import {
  buildEvalSummary,
  evaluateEvalCase,
  renderEvalSummaryMarkdown,
  validateEvalCase,
  validateEvalSuiteConfig,
} from './evals';

describe('eval utilities', () => {
  it('validates a template eval case', () => {
    const evalCase = validateEvalCase({
      id: 'invoice-template',
      mode: 'template',
      inputPath: 'evals/corpus/invoice.pdf',
      presetId: 'invoice',
      expectedAssertions: [
        { type: 'json_field_exists', path: 'fields.invoice_number.value' },
        { type: 'pass_rate_weight', value: 2 },
      ],
      tags: ['invoice', 'template'],
    });

    expect(evalCase.id).toBe('invoice-template');
    expect(evalCase.presetId).toBe('invoice');
  });

  it('validates simple and agentic config', () => {
    const simpleCase = validateEvalCase({
      id: 'simple-resume',
      mode: 'simple',
      inputPath: 'evals/corpus/resume.pdf',
      expectedAssertions: [
        { type: 'contains', target: 'markdown', value: 'Jordan Lee' },
      ],
      tags: ['resume', 'simple'],
    });

    const agenticCase = validateEvalCase({
      id: 'agentic-business-card',
      mode: 'agentic',
      inputPath: 'evals/corpus/business-card.pdf',
      agentConfig: {
        maxIterations: 4,
        confidenceThreshold: 0.65,
      },
      expectedAssertions: [
        { type: 'json_field_exists', path: 'extractedFields.email.value' },
      ],
      tags: ['business-card', 'agentic'],
    });

    expect(simpleCase.mode).toBe('simple');
    expect(agenticCase.mode).toBe('agentic');
    expect(agenticCase.agentConfig?.maxIterations).toBe(4);
  });

  it('rejects unknown eval modes', () => {
    expect(() => validateEvalCase({
      id: 'unknown-mode',
      mode: 'ocr',
      inputPath: 'evals/corpus/resume.pdf',
      expectedAssertions: [],
    })).toThrow('must use mode "simple", "template", or "agentic"');
  });

  it('rejects invalid eval cases', () => {
    expect(() => validateEvalCase({
      id: 'broken',
      mode: 'template',
      inputPath: '',
      expectedAssertions: [],
      tags: [],
    })).toThrow(/inputPath/);

    expect(() => validateEvalCase({
      id: 'broken-agentic',
      mode: 'agentic',
      inputPath: 'evals/corpus/invoice.pdf',
      agentConfig: {
        confidenceThreshold: 2,
      },
      expectedAssertions: [
        { type: 'json_field_exists', path: 'extractedFields.invoice_number.value' },
      ],
      tags: ['agentic'],
    })).toThrow(/confidenceThreshold/);
  });

  it('evaluates assertions against structured output', () => {
    const evalCase = validateEvalCase({
      id: 'receipt-template',
      mode: 'template',
      inputPath: 'evals/corpus/receipt.pdf',
      presetId: 'receipt',
      expectedAssertions: [
        { type: 'contains', target: 'markdown', value: 'Market Street Grocer' },
        { type: 'json_field_equals', path: 'fields.total.value', expected: '27.00' },
        { type: 'json_field_number_min', path: 'requiredCoverage', min: 0.9 },
        { type: 'table_min_rows', minRows: 2 },
      ],
      tags: ['receipt'],
    });

    const result = evaluateEvalCase(evalCase, {
      markdown: '# Receipt\n\nMerchant: Market Street Grocer',
      csv: 'item,quantity,price\nApples,2,4.00\nMilk,1,3.50',
      json: {
        fields: {
          total: {
            value: '27.00',
          },
        },
        requiredCoverage: 1,
        rows: [
          { item: 'Apples', quantity: '2', price: '4.00' },
          { item: 'Milk', quantity: '1', price: '3.50' },
        ],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.failedAssertions).toHaveLength(0);
    expect(result.weight).toBe(1);
  });

  it('evaluates objective metric thresholds from ground truth', () => {
    const evalCase = validateEvalCase({
      id: 'simple-ground-truth',
      mode: 'simple',
      inputPath: 'evals/corpus/invoice.pdf',
      reference: { textPath: 'evals/references/invoice.txt' },
      expectedAssertions: [
        { type: 'metric_min', metric: 'text_coverage', value: 0.9 },
        { type: 'metric_max', metric: 'unsupported_text_rate', value: 0.1 },
      ],
      tags: ['simple'],
    });

    const result = evaluateEvalCase(
      evalCase,
      { markdown: '# Invoice\n\nTotal 16.00' },
      { text: 'Invoice\nTotal 16.00' },
      { durationMs: 25 },
    );

    expect(result.passed).toBe(true);
    expect(result.metrics?.normalized_cer).toBe(0);
    expect(result.execution?.durationMs).toBe(25);
  });

  it('scores olmOCR-style unit tests as a pass-rate metric', () => {
    const evalCase = validateEvalCase({
      id: 'olmocr-style',
      mode: 'simple',
      inputPath: 'evals/cache/olmocrbench/pdfs/000.pdf',
      reference: { unitTestsPath: 'evals/cache/olmocrbench/references/000.tests.json' },
      expectedAssertions: [{ type: 'metric_min', metric: 'unit_test_pass_rate', value: 0.6 }],
      tags: ['olmocrbench'],
    });
    expect(evalCase.reference?.unitTestsPath).toBe('evals/cache/olmocrbench/references/000.tests.json');

    const result = evaluateEvalCase(evalCase, { markdown: 'Dear friend, the school begins in January.' }, {
      unitTests: [
        { id: 'a', type: 'present', text: 'the school begins' },
        { id: 'b', type: 'order', before: 'Dear friend', after: 'January' },
        { id: 'c', type: 'present', text: 'missing sentence' },
      ],
    });

    expect(result.metrics?.unit_test_pass_rate).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(true);
  });

  it('treats missing JSON paths and undefined values differently', () => {
    const evalCase = validateEvalCase({
      id: 'agentic-output',
      mode: 'agentic',
      inputPath: 'evals/corpus/invoice.pdf',
      expectedAssertions: [
        { type: 'json_field_exists', path: 'extractedFields.total_amount.value' },
        { type: 'json_field_equals', path: 'documentType', expected: 'invoice' },
      ],
      tags: ['agentic'],
    });

    const result = evaluateEvalCase(evalCase, {
      markdown: '# Agentic OCR Extraction',
      json: {
        documentType: 'invoice',
        extractedFields: {
          total_amount: {
            value: '1471.50',
          },
        },
      },
    });

    expect(result.passed).toBe(true);
  });

  it('builds summaries and renders markdown reports', () => {
    const summary = buildEvalSummary(
      'gemini-3.5-flash-lite',
      [
        { id: 'invoice', passed: true, weight: 2, failedAssertions: [] },
        { id: 'resume', passed: false, weight: 1, failedAssertions: ['Expected JSON path "fields.email.value" to exist.'] },
      ],
      validateEvalSuiteConfig({
        suiteAssertions: [
          { type: 'overall_score_min', value: 0.8 },
        ],
      }),
    );

    const markdown = renderEvalSummaryMarkdown(summary);

    expect(summary.weightedScore).toBeCloseTo(2 / 3);
    expect(summary.status).toBe('failed');
    expect(markdown).toContain('# AI Eval Report');
    expect(markdown).toContain('resume');
    expect(markdown).toContain('Weighted score 0.67 is below required threshold 0.80.');
  });

  it('falls back to pass rate when all eval weights are zero', () => {
    const summary = buildEvalSummary(
      'gemini-3.5-flash-lite',
      [
        { id: 'case-1', passed: true, weight: 0, failedAssertions: [] },
        { id: 'case-2', passed: false, weight: 0, failedAssertions: ['failed'] },
      ],
    );

    expect(summary.weightedScore).toBe(0.5);
  });
});
