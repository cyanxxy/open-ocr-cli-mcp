import {
  scoreFields,
  scoreOcrText,
  scoreTableCells,
  type EvalMetricName,
  type EvalMetricScores,
} from './evalMetrics';
import { scoreOcrUnitTests, type OcrUnitTest } from './evalUnitTests';
import type { PresetRunResult } from './gemini/types';

export type EvalMode = 'simple' | 'template' | 'agentic';
export type EvalSuiteName = 'canary' | 'full' | 'benchmark';

export type EvalAssertion =
  | { type: 'contains'; target: 'markdown' | 'csv'; value: string }
  | { type: 'not_contains'; target: 'markdown' | 'csv'; value: string }
  | { type: 'json_field_equals'; path: string; expected: string | number | boolean | null }
  | { type: 'json_field_exists'; path: string }
  | { type: 'json_field_number_min'; path: string; min: number }
  | { type: 'table_min_rows'; minRows: number; path?: string }
  | { type: 'metric_min'; metric: EvalMetricName; value: number }
  | { type: 'metric_max'; metric: EvalMetricName; value: number }
  | { type: 'pass_rate_weight'; value: number }
  | { type: 'overall_score_min'; value: number };

export interface EvalReference {
  textPath?: string;
  jsonPath?: string;
  /** JSON array of olmOCR-style pass/fail checks scored as `unit_test_pass_rate`. */
  unitTestsPath?: string;
  referenceFieldsPath?: string;
  predictedFieldsPath?: string;
  referenceRowsPath?: string;
  predictedRowsPath?: string;
  criticalFields?: string[];
}

export interface EvalGroundTruth {
  text?: string;
  json?: Record<string, unknown> | null;
  unitTests?: OcrUnitTest[];
}

export interface EvalCase {
  id: string;
  mode: EvalMode;
  inputPath: string;
  presetId?: string;
  agentConfig?: {
    maxIterations?: number;
    confidenceThreshold?: number;
  };
  reference?: EvalReference;
  expectedAssertions: EvalAssertion[];
  tags: string[];
  suites: EvalSuiteName[];
}

export interface EvalFailure {
  id: string;
  message: string;
  failedAssertions: string[];
  runtimeError?: string;
}

export interface EvalBreakdown {
  totalCases: number;
  passCount: number;
  passRate: number;
  metrics: EvalMetricScores;
  averageDurationMs?: number;
  averageTotalTokens?: number;
  totalEstimatedCostUsd?: number;
}

export interface EvalMetricStatistics {
  mean: number;
  min: number;
  max: number;
  standardDeviation: number;
  samples: number;
}

export interface EvalRunSummary {
  provider?: string;
  gateway?: string;
  model: string;
  suite?: EvalSuiteName;
  totalCases: number;
  passCount: number;
  passRate: number;
  weightedScore: number;
  metrics?: EvalMetricScores;
  metricStatistics?: Partial<Record<EvalMetricName, EvalMetricStatistics>>;
  modeBreakdown?: Record<string, EvalBreakdown>;
  tagBreakdown?: Record<string, EvalBreakdown>;
  caseResults?: EvalCaseResult[];
  failures: EvalFailure[];
  runAt: string;
  status?: 'success' | 'failed' | 'pending';
  notes?: string[];
}

export interface EvalExecutionMetadata {
  durationMs: number;
  repeatIndex?: number;
  iterations?: number;
  toolCalls?: number;
  apiRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  runtimeError?: string;
}

export interface EvalCaseResult {
  id: string;
  passed: boolean;
  weight: number;
  failedAssertions: string[];
  mode?: EvalMode;
  tags?: string[];
  metrics?: EvalMetricScores;
  execution?: EvalExecutionMetadata;
}

export interface EvalRunOutput {
  markdown: string;
  csv?: string;
  /**
   * The run's structured payload, shaped by whichever mode produced it.
   *
   * Deliberately `unknown`: every consumer reads it through `getValueAtPath`,
   * which already takes `unknown` and validates as it walks. Declaring
   * `Record<string, unknown>` promised an index signature that neither
   * `ExtractedContent` nor a preset result actually has, so each producer had to
   * launder its value through `as unknown as` — an unchecked assertion in
   * exchange for a guarantee nothing consumed.
   */
  json?: unknown;
}

export interface EvalSuiteConfig {
  suiteAssertions?: Array<Extract<EvalAssertion, { type: 'overall_score_min' }>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PathLookup =
  | { found: true; value: unknown }
  | { found: false; value: undefined };

function normalizeEvalMode(mode: unknown): EvalMode | null {
  if (mode === 'simple' || mode === 'template' || mode === 'agentic') return mode;
  return null;
}

function isEvalMetricName(value: unknown): value is EvalMetricName {
  return typeof value === 'string' && [
    'cer',
    'normalized_cer',
    'wer',
    'normalized_edit_similarity',
    'text_coverage',
    'unsupported_text_rate',
    'field_precision',
    'field_recall',
    'field_f1',
    'critical_field_exact_match',
    'table_cell_f1',
    'unit_test_pass_rate',
  ].includes(value);
}

function isAllowedAssertion(assertion: unknown): assertion is EvalAssertion {
  if (!isRecord(assertion) || typeof assertion.type !== 'string') return false;

  switch (assertion.type) {
    case 'contains':
    case 'not_contains':
      return (assertion.target === 'markdown' || assertion.target === 'csv') && typeof assertion.value === 'string';
    case 'json_field_equals':
      return typeof assertion.path === 'string' && 'expected' in assertion;
    case 'json_field_exists':
      return typeof assertion.path === 'string';
    case 'json_field_number_min':
      return typeof assertion.path === 'string' && typeof assertion.min === 'number';
    case 'table_min_rows':
      return typeof assertion.minRows === 'number' && (assertion.path === undefined || typeof assertion.path === 'string');
    case 'metric_min':
    case 'metric_max':
      return isEvalMetricName(assertion.metric) && typeof assertion.value === 'number';
    case 'pass_rate_weight':
    case 'overall_score_min':
      return typeof assertion.value === 'number';
    default:
      return false;
  }
}

function validateReference(value: unknown, caseId: string): EvalReference | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)) throw new Error(`Eval case "${caseId}" reference must be an object.`);

  const stringKeys = [
    'textPath',
    'jsonPath',
    'unitTestsPath',
    'referenceFieldsPath',
    'predictedFieldsPath',
    'referenceRowsPath',
    'predictedRowsPath',
  ] as const;
  for (const key of stringKeys) {
    if (value[key] != null && typeof value[key] !== 'string') {
      throw new Error(`Eval case "${caseId}" reference.${key} must be a string.`);
    }
  }
  if (value.criticalFields != null && (!Array.isArray(value.criticalFields) || !value.criticalFields.every((entry) => typeof entry === 'string'))) {
    throw new Error(`Eval case "${caseId}" reference.criticalFields must contain strings.`);
  }

  return {
    textPath: typeof value.textPath === 'string' ? value.textPath : undefined,
    jsonPath: typeof value.jsonPath === 'string' ? value.jsonPath : undefined,
    unitTestsPath: typeof value.unitTestsPath === 'string' ? value.unitTestsPath : undefined,
    referenceFieldsPath: typeof value.referenceFieldsPath === 'string' ? value.referenceFieldsPath : undefined,
    predictedFieldsPath: typeof value.predictedFieldsPath === 'string' ? value.predictedFieldsPath : undefined,
    referenceRowsPath: typeof value.referenceRowsPath === 'string' ? value.referenceRowsPath : undefined,
    predictedRowsPath: typeof value.predictedRowsPath === 'string' ? value.predictedRowsPath : undefined,
    criticalFields: Array.isArray(value.criticalFields)
      ? value.criticalFields.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
  };
}

export function validateEvalCase(input: unknown): EvalCase {
  if (!isRecord(input)) throw new Error('Eval case must be an object.');
  if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Eval case id is required.');

  const mode = normalizeEvalMode(input.mode);
  if (!mode) throw new Error(`Eval case "${input.id}" must use mode "simple", "template", or "agentic".`);
  if (typeof input.inputPath !== 'string' || !input.inputPath.trim()) throw new Error(`Eval case "${input.id}" is missing inputPath.`);
  if (mode === 'template' && (typeof input.presetId !== 'string' || !input.presetId.trim())) {
    throw new Error(`Template eval case "${input.id}" must provide presetId.`);
  }

  if (mode === 'agentic' && input.agentConfig != null) {
    if (!isRecord(input.agentConfig)) throw new Error(`Agentic eval case "${input.id}" must use an object for agentConfig.`);
    const { maxIterations, confidenceThreshold } = input.agentConfig;
    if (maxIterations != null && (typeof maxIterations !== 'number' || maxIterations < 1)) {
      throw new Error(`Agentic eval case "${input.id}" must use a positive number for agentConfig.maxIterations.`);
    }
    if (confidenceThreshold != null && (typeof confidenceThreshold !== 'number' || confidenceThreshold < 0 || confidenceThreshold > 1)) {
      throw new Error(`Agentic eval case "${input.id}" must use a 0-1 number for agentConfig.confidenceThreshold.`);
    }
  }

  if (!Array.isArray(input.expectedAssertions) || input.expectedAssertions.length === 0) {
    throw new Error(`Eval case "${input.id}" must include at least one assertion.`);
  }
  if (!input.expectedAssertions.every(isAllowedAssertion)) throw new Error(`Eval case "${input.id}" includes an invalid assertion.`);
  if (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === 'string')) {
    throw new Error(`Eval case "${input.id}" must provide string tags.`);
  }
  const suitesInput = input.suites ?? ['canary', 'full'];
  if (!Array.isArray(suitesInput) || !suitesInput.every((suite) => suite === 'canary' || suite === 'full' || suite === 'benchmark')) {
    throw new Error(`Eval case "${input.id}" includes an invalid suite.`);
  }

  return {
    id: input.id,
    mode,
    inputPath: input.inputPath,
    presetId: typeof input.presetId === 'string' ? input.presetId : undefined,
    agentConfig: isRecord(input.agentConfig)
      ? {
          maxIterations: typeof input.agentConfig.maxIterations === 'number' ? input.agentConfig.maxIterations : undefined,
          confidenceThreshold: typeof input.agentConfig.confidenceThreshold === 'number' ? input.agentConfig.confidenceThreshold : undefined,
        }
      : undefined,
    reference: validateReference(input.reference, input.id),
    expectedAssertions: input.expectedAssertions,
    tags: input.tags,
    suites: suitesInput as EvalSuiteName[],
  };
}

export function validateEvalSuiteConfig(input: unknown): EvalSuiteConfig {
  if (input == null) return {};
  if (!isRecord(input)) throw new Error('Eval suite config must be an object.');
  const suiteAssertions = input.suiteAssertions;
  if (suiteAssertions == null) return {};
  if (!Array.isArray(suiteAssertions) || !suiteAssertions.every(isAllowedAssertion)) {
    throw new Error('Eval suite config contains invalid suiteAssertions.');
  }
  return {
    suiteAssertions: suiteAssertions.filter(
      (assertion): assertion is Extract<EvalAssertion, { type: 'overall_score_min' }> => assertion.type === 'overall_score_min',
    ),
  };
}

export function getEvalCaseWeight(evalCase: EvalCase): number {
  return evalCase.expectedAssertions.find(
    (assertion): assertion is Extract<EvalAssertion, { type: 'pass_rate_weight' }> => assertion.type === 'pass_rate_weight',
  )?.value ?? 1;
}

export function getValueAtPath(input: unknown, path: string): PathLookup {
  if (!path) return { found: true, value: input };
  let current: unknown = input;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (isRecord(current) && segment in current) {
      current = current[segment];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function formatAssertionFailure(assertion: EvalAssertion): string {
  switch (assertion.type) {
    case 'contains': return `Expected ${assertion.target} to contain "${assertion.value}".`;
    case 'not_contains': return `Expected ${assertion.target} to omit "${assertion.value}".`;
    case 'json_field_equals': return `Expected JSON path "${assertion.path}" to equal ${JSON.stringify(assertion.expected)}.`;
    case 'json_field_exists': return `Expected JSON path "${assertion.path}" to exist.`;
    case 'json_field_number_min': return `Expected JSON path "${assertion.path}" to be at least ${assertion.min}.`;
    case 'table_min_rows': return `Expected table at "${assertion.path ?? 'rows'}" to have at least ${assertion.minRows} rows.`;
    case 'metric_min': return `Expected metric "${assertion.metric}" to be at least ${assertion.value}.`;
    case 'metric_max': return `Expected metric "${assertion.metric}" to be at most ${assertion.value}.`;
    case 'overall_score_min': return `Expected overall weighted score to be at least ${assertion.value}.`;
    case 'pass_rate_weight': return '';
  }
}

function computeMetrics(evalCase: EvalCase, output: EvalRunOutput, groundTruth?: EvalGroundTruth): EvalMetricScores {
  const metrics: EvalMetricScores = {};
  if (typeof groundTruth?.text === 'string') Object.assign(metrics, scoreOcrText(groundTruth.text, output.markdown));
  if (groundTruth?.unitTests?.length) {
    metrics.unit_test_pass_rate = scoreOcrUnitTests(groundTruth.unitTests, output.markdown).passRate;
  }

  if (groundTruth?.json && evalCase.reference?.jsonPath) {
    const referenceFields = getValueAtPath(groundTruth.json, evalCase.reference.referenceFieldsPath ?? 'fields');
    const predictedFields = getValueAtPath(output.json, evalCase.reference.predictedFieldsPath ?? 'fields');
    if (referenceFields.found && predictedFields.found) {
      Object.assign(metrics, scoreFields(referenceFields.value, predictedFields.value, {
        criticalFields: evalCase.reference.criticalFields,
      }));
    }

    const referenceRows = getValueAtPath(groundTruth.json, evalCase.reference.referenceRowsPath ?? 'rows');
    const predictedRows = getValueAtPath(output.json, evalCase.reference.predictedRowsPath ?? 'rows');
    if (referenceRows.found && predictedRows.found) Object.assign(metrics, scoreTableCells(referenceRows.value, predictedRows.value));
  }
  return metrics;
}

export function evaluateEvalCase(
  evalCase: EvalCase,
  output: EvalRunOutput,
  groundTruth?: EvalGroundTruth,
  execution?: EvalExecutionMetadata,
): EvalCaseResult {
  const failures: string[] = [];
  const metrics = computeMetrics(evalCase, output, groundTruth);

  for (const assertion of evalCase.expectedAssertions) {
    switch (assertion.type) {
      case 'contains':
        if (!(output[assertion.target] || '').includes(assertion.value)) failures.push(formatAssertionFailure(assertion));
        break;
      case 'not_contains':
        if ((output[assertion.target] || '').includes(assertion.value)) failures.push(formatAssertionFailure(assertion));
        break;
      case 'json_field_equals': {
        const resolved = getValueAtPath(output.json, assertion.path);
        if (!resolved.found || resolved.value !== assertion.expected) failures.push(formatAssertionFailure(assertion));
        break;
      }
      case 'json_field_exists': {
        const resolved = getValueAtPath(output.json, assertion.path);
        if (!resolved.found || resolved.value === null || resolved.value === '') failures.push(formatAssertionFailure(assertion));
        break;
      }
      case 'json_field_number_min': {
        const resolved = getValueAtPath(output.json, assertion.path);
        if (!resolved.found || typeof resolved.value !== 'number' || resolved.value < assertion.min) failures.push(formatAssertionFailure(assertion));
        break;
      }
      case 'table_min_rows': {
        const resolved = getValueAtPath(output.json, assertion.path ?? 'rows');
        if (!resolved.found || !Array.isArray(resolved.value) || resolved.value.length < assertion.minRows) failures.push(formatAssertionFailure(assertion));
        break;
      }
      case 'metric_min':
        if (metrics[assertion.metric] == null || (metrics[assertion.metric] ?? 0) < assertion.value) failures.push(formatAssertionFailure(assertion));
        break;
      case 'metric_max':
        if (metrics[assertion.metric] == null || (metrics[assertion.metric] ?? Number.POSITIVE_INFINITY) > assertion.value) failures.push(formatAssertionFailure(assertion));
        break;
      case 'pass_rate_weight':
      case 'overall_score_min':
        break;
    }
  }

  if (execution?.runtimeError) failures.push(`Eval runner error: ${execution.runtimeError}`);
  return {
    id: evalCase.id,
    passed: failures.length === 0,
    weight: getEvalCaseWeight(evalCase),
    failedAssertions: failures,
    mode: evalCase.mode,
    tags: evalCase.tags,
    metrics,
    execution,
  };
}

function averageMetrics(results: EvalCaseResult[]): EvalMetricScores {
  return Object.fromEntries(Object.entries(metricStatistics(results)).map(([name, statistics]) => [name, statistics?.mean]));
}

function metricStatistics(results: EvalCaseResult[]): Partial<Record<EvalMetricName, EvalMetricStatistics>> {
  const values = new Map<EvalMetricName, number[]>();
  for (const result of results) {
    for (const [name, value] of Object.entries(result.metrics ?? {}) as Array<[EvalMetricName, number]>) {
      const entries = values.get(name) ?? [];
      entries.push(value);
      values.set(name, entries);
    }
  }
  return Object.fromEntries([...values].map(([name, entries]) => {
    const mean = entries.reduce((sum, value) => sum + value, 0) / entries.length;
    const variance = entries.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / entries.length;
    return [name, {
      mean,
      min: Math.min(...entries),
      max: Math.max(...entries),
      standardDeviation: Math.sqrt(variance),
      samples: entries.length,
    }];
  }));
}

function buildBreakdown(results: EvalCaseResult[]): EvalBreakdown {
  const passCount = results.filter((result) => result.passed).length;
  const durations = results.map((result) => result.execution?.durationMs).filter((value): value is number => typeof value === 'number');
  const totalTokens = results.map((result) => result.execution?.totalTokens).filter((value): value is number => typeof value === 'number');
  const costs = results.map((result) => result.execution?.estimatedCostUsd).filter((value): value is number => typeof value === 'number');
  return {
    totalCases: results.length,
    passCount,
    passRate: results.length === 0 ? 0 : passCount / results.length,
    metrics: averageMetrics(results),
    averageDurationMs: durations.length === 0 ? undefined : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    averageTotalTokens: totalTokens.length === 0 ? undefined : totalTokens.reduce((sum, value) => sum + value, 0) / totalTokens.length,
    totalEstimatedCostUsd: costs.length === 0 ? undefined : costs.reduce((sum, value) => sum + value, 0),
  };
}

function groupBreakdowns(results: EvalCaseResult[], keys: (result: EvalCaseResult) => string[]): Record<string, EvalBreakdown> {
  const groups = new Map<string, EvalCaseResult[]>();
  for (const result of results) {
    for (const key of keys(result)) groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  return Object.fromEntries([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => [key, buildBreakdown(entries)]));
}

export function buildEvalSummary(
  model: string,
  caseResults: EvalCaseResult[],
  suiteConfig: EvalSuiteConfig = {},
  suite?: EvalSuiteName,
): EvalRunSummary {
  const totalWeight = caseResults.reduce((sum, result) => sum + result.weight, 0);
  const passingWeight = caseResults.reduce((sum, result) => sum + (result.passed ? result.weight : 0), 0);
  const passCount = caseResults.filter((result) => result.passed).length;
  const weightedScore = totalWeight > 0 ? passingWeight / totalWeight : (caseResults.length === 0 ? 0 : passCount / caseResults.length);
  const failures = caseResults.filter((result) => !result.passed).map((result) => ({
    id: result.id,
    message: `Case ${result.id} failed ${result.failedAssertions.length} assertion(s).`,
    failedAssertions: result.failedAssertions,
    runtimeError: result.execution?.runtimeError,
  }));
  const notes: string[] = [];
  const threshold = suiteConfig.suiteAssertions?.find((assertion) => assertion.type === 'overall_score_min');
  let status: EvalRunSummary['status'] = failures.length > 0 ? 'failed' : 'success';
  if (threshold && weightedScore < threshold.value) {
    status = 'failed';
    notes.push(`Weighted score ${weightedScore.toFixed(2)} is below required threshold ${threshold.value.toFixed(2)}.`);
  }

  return {
    model,
    suite,
    totalCases: caseResults.length,
    passCount,
    passRate: caseResults.length === 0 ? 0 : passCount / caseResults.length,
    weightedScore,
    metrics: averageMetrics(caseResults),
    metricStatistics: metricStatistics(caseResults),
    modeBreakdown: groupBreakdowns(caseResults, (result) => [result.mode ?? 'unknown']),
    tagBreakdown: groupBreakdowns(caseResults, (result) => result.tags ?? []),
    caseResults,
    failures,
    runAt: new Date().toISOString(),
    status,
    notes: notes.length > 0 ? notes : undefined,
  };
}

const PERCENT_METRICS = new Set<EvalMetricName>([
  'normalized_edit_similarity', 'text_coverage', 'field_precision', 'field_recall', 'field_f1', 'critical_field_exact_match', 'table_cell_f1',
  'unit_test_pass_rate',
]);

function formatMetric(name: EvalMetricName, value: number): string {
  return PERCENT_METRICS.has(name) ? `${(value * 100).toFixed(1)}%` : value.toFixed(3);
}

function renderMetricTable(
  metrics: EvalMetricScores | undefined,
  statistics?: Partial<Record<EvalMetricName, EvalMetricStatistics>>,
): string[] {
  const entries = Object.entries(metrics ?? {}) as Array<[EvalMetricName, number]>;
  if (entries.length === 0) return ['- No ground-truth metrics were available.', ''];
  return [
    '| Metric | Mean | Min | Max | Std dev | Samples |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...entries.map(([name, value]) => {
      const stat = statistics?.[name];
      return `| ${name} | ${formatMetric(name, value)} | ${stat ? formatMetric(name, stat.min) : '-'} | ${stat ? formatMetric(name, stat.max) : '-'} | ${stat?.standardDeviation.toFixed(3) ?? '-'} | ${stat?.samples ?? '-'} |`;
    }),
    '',
  ];
}

export function renderEvalSummaryMarkdown(summary: EvalRunSummary): string {
  const lines = [
    '# AI Eval Report', '',
    ...(summary.provider ? [`- Provider: \`${summary.provider}\``] : []),
    ...(summary.gateway ? [`- Gateway: \`${summary.gateway}\``] : []),
    `- Model: \`${summary.model}\``,
    `- Suite: \`${summary.suite ?? 'full'}\``,
    `- Run at: ${summary.runAt}`,
    `- Status: ${summary.status ?? 'success'}`,
    `- Total cases: ${summary.totalCases}`,
    `- Passed: ${summary.passCount}`,
    `- Pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
    `- Weighted assertion score: ${(summary.weightedScore * 100).toFixed(1)}%`,
    '', '## Quality metrics', '', ...renderMetricTable(summary.metrics, summary.metricStatistics),
    '## Mode breakdown', '',
    '| Mode | Cases | Pass rate | Normalized CER | Field F1 | Duration | Tokens | Est. cost |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.modeBreakdown ?? {}).map(([mode, result]) => `| ${mode} | ${result.totalCases} | ${(result.passRate * 100).toFixed(1)}% | ${result.metrics.normalized_cer?.toFixed(3) ?? '-'} | ${result.metrics.field_f1 == null ? '-' : `${(result.metrics.field_f1 * 100).toFixed(1)}%`} | ${result.averageDurationMs == null ? '-' : `${Math.round(result.averageDurationMs)} ms`} | ${result.averageTotalTokens == null ? '-' : Math.round(result.averageTotalTokens)} | ${result.totalEstimatedCostUsd == null ? '-' : `$${result.totalEstimatedCostUsd.toFixed(4)}`} |`),
    '',
  ];

  if (summary.notes?.length) lines.push('## Notes', '', ...summary.notes.map((note) => `- ${note}`), '');
  lines.push('## Failures', '');
  if (summary.failures.length === 0) lines.push('- None');
  else for (const failure of summary.failures) lines.push(`### ${failure.id}`, '', failure.message, '', ...failure.failedAssertions.map((entry) => `- ${entry}`), '');
  return `${lines.join('\n').trim()}\n`;
}

export function toEvalRunOutput(result: PresetRunResult): EvalRunOutput {
  return { markdown: result.markdown, csv: result.csv, json: result.json };
}
