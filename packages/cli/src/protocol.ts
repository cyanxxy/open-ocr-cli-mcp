import { createHash } from 'node:crypto';
import path from 'node:path';

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { FILE_CONSTRAINTS } from '@open-ocr/engine/constants';
import type { AgentStep } from '@open-ocr/engine/agentTypes';
import type { ThinkingLevel } from '@open-ocr/engine/gemini';
import {
  PROVIDER_PROFILES,
  type GatewayId,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderUsageSnapshot,
} from '@open-ocr/engine/providers';
import { listExtractionPresets } from '@open-ocr/engine/templates';
import capabilitiesV2Schema from '../schemas/capabilities-v2.schema.json';
import errorV2Schema from '../schemas/error-v2.schema.json';
import eventV2Schema from '../schemas/event-v2.schema.json';
import requestV2Schema from '../schemas/request-v2.schema.json';
import resultV2Schema from '../schemas/result-v2.schema.json';
import { cliThinkingLevels, defaultCliThinkingLevel } from './config';
import { CliExitError, OCR_ERROR_CODES, type OcrErrorCode, type OcrErrorPayload } from './errors';
import { OCR_REQUEST_LIMITS, type NumericRange, type OcrRequestLimitKey } from './limits';
import type { ArtifactExtension, ArtifactTarget } from './output';
import type { BatchSummary, CliFormat, CliMode, OcrJobResult } from './types';

export const OCR_PROTOCOL_VERSION = 2 as const;
export type OcrProtocolVersion = typeof OCR_PROTOCOL_VERSION;
export const OCR_PROTOCOL_SCHEMA_IDS = {
  request: requestV2Schema.$id,
  result: resultV2Schema.$id,
  event: eventV2Schema.$id,
  error: errorV2Schema.$id,
  capabilities: capabilitiesV2Schema.$id,
} as const;

/**
 * Every bundled schema, addressable by short name, versioned name, and the
 * `$id` URL it declares.
 *
 * The `$id`s are keys because `capabilities` publishes them in `schemas` next
 * to `schemaAccess.networkFetch: false`: an agent is handed a URL it is told
 * not to fetch, so `open-ocr-cli schema <name>` has to accept the identifier
 * capabilities advertised. Keeping the identifier here rather than in the command
 * leaves `capabilities` output untouched — capabilities-v2 is strict and its
 * `schemas` shape is frozen. protocol.test.ts asserts every declared `$id`
 * resolves back to its own schema so the two lists cannot drift.
 */
export const OCR_PROTOCOL_SCHEMAS = {
  request: requestV2Schema,
  result: resultV2Schema,
  event: eventV2Schema,
  error: errorV2Schema,
  capabilities: capabilitiesV2Schema,
  'request-v2': requestV2Schema,
  'result-v2': resultV2Schema,
  'event-v2': eventV2Schema,
  'error-v2': errorV2Schema,
  'capabilities-v2': capabilitiesV2Schema,
  'https://open-ocr.dev/schemas/request-v2.schema.json': requestV2Schema,
  'https://open-ocr.dev/schemas/result-v2.schema.json': resultV2Schema,
  'https://open-ocr.dev/schemas/event-v2.schema.json': eventV2Schema,
  'https://open-ocr.dev/schemas/error-v2.schema.json': errorV2Schema,
  'https://open-ocr.dev/schemas/capabilities-v2.schema.json': capabilitiesV2Schema,
} as const;

/**
 * The names `open-ocr-cli schema <name>` accepts, minus the `$id` URLs.
 *
 * Reported back when a lookup misses, so the recovery step is the answer itself
 * rather than another discovery round-trip. The URLs are deliberately omitted:
 * they are long, `capabilities` already publishes them under `schemas`, and an
 * agent that has one does not need this list.
 */
export const OCR_PROTOCOL_SCHEMA_NAMES: readonly string[] = Object.keys(OCR_PROTOCOL_SCHEMAS)
  .filter((name) => !name.includes('://'));

export interface OcrJobRequestPathInput {
  type: 'path';
  path: string;
}

export interface OcrJobRequestStdinInput {
  type: 'stdin';
  name?: string;
  mimeType?: string;
}

export interface OcrJobRequestUrlInput {
  type: 'url';
  url: string;
}

export type OcrJobRequestInput =
  | OcrJobRequestPathInput
  | OcrJobRequestStdinInput
  | OcrJobRequestUrlInput;

/**
 * True for both spellings of "read this document from stdin".
 *
 * `{ type: 'path', path: '-' }` is the one a caller reaches for by habit, and it
 * is what the job service turns back into a stdin read. Every front end has to
 * agree on that, so the rule lives here rather than being re-derived: the MCP
 * server used to check only `type: 'stdin'` and let `-` through onto the stdio
 * transport it shares with JSON-RPC.
 */
export function isStdinRequestInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return input.type === 'stdin' || (input.type === 'path' && input.path === '-');
}

export type OcrProgressLevel = 'off' | 'standard' | 'detailed';
export type OcrDeliveryMode = 'inline' | 'reference';

export interface OcrJobRequest {
  protocolVersion: OcrProtocolVersion;
  operation: 'extract';
  inputs: OcrJobRequestInput[];
  configPath?: string;
  noConfig?: boolean;
  provider?: {
    id?: ProviderId;
    gateway?: GatewayId;
    model?: string;
  };
  extraction?: {
    mode?: CliMode;
    preset?: string;
    contentFormat?: CliFormat;
    schema?: Record<string, unknown>;
    schemaPath?: string;
    instructions?: string[];
    thinking?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    progress?: OcrProgressLevel;
    detectImages?: boolean;
    detectMath?: boolean;
    maxTokens?: number;
    maxIterations?: number;
    confidenceThreshold?: number;
  };
  execution?: {
    concurrency?: number;
    retries?: number;
    timeoutSeconds?: number;
    maxFiles?: number;
    maxTotalMb?: number;
    maxCostUsd?: number;
    requestsPerMinute?: number;
    failFast?: boolean;
  };
  discovery?: {
    hidden?: boolean;
    exclude?: string[];
  };
  web?: {
    analysis?: 'individual' | 'combined' | 'comparison';
  };
  delivery?: {
    mode?: OcrDeliveryMode;
    outputDirectory?: string;
    resume?: boolean;
  };
  dryRun?: boolean;
}

export interface OcrArtifactReference {
  path: string;
  mediaType: string;
  kind: 'markdown' | 'json' | 'csv' | 'agent-steps';
}

export interface OcrProtocolDocument {
  documentId: string;
  source: string;
  status: OcrJobResult['status'];
  mode: CliMode;
  provider: ProviderId;
  gateway: GatewayId;
  model: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  attempts: number;
  skipReason?: OcrJobResult['skipReason'];
  partialReason?: OcrJobResult['partialReason'];
  nextAction?: OcrJobResult['nextAction'];
  artifacts: OcrArtifactReference[];
  plannedArtifacts: OcrArtifactReference[];
  content?: {
    markdown?: string;
    json?: unknown;
    csv?: string;
    agentSteps?: OcrProtocolStep[];
  };
  error?: OcrErrorPayload;
}

export interface OcrRunResult {
  protocolVersion: OcrProtocolVersion;
  type: 'run.result';
  ok: boolean;
  runId: string;
  status: 'succeeded' | 'partial' | 'failed' | 'validated' | 'cancelled' | 'cost_limited';
  startedAt: string;
  completedAt: string;
  durationMs: number;
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  mode: CliMode;
  provider: ProviderId;
  gateway: GatewayId;
  model: string;
  usage: ProviderUsageSnapshot;
  costLimitUsd?: number;
  costLimitReached: boolean;
  /**
   * Everything the run could not honour in full, in the order it was noticed:
   * request fields the resolved mode does not read, documents a directory scan
   * passed over, a resume that cannot match, a schema construct the provider
   * may refuse. Always present, often empty. It exists because the `run` and
   * MCP surfaces have no other channel an agent reads — stderr is diagnostics
   * that a host may not forward, and the skill tells agents not to parse it.
   */
  warnings: string[];
  documents: OcrProtocolDocument[];
}

export interface OcrRunFailure {
  protocolVersion: OcrProtocolVersion;
  type: 'run.result';
  ok: false;
  runId: string;
  status: 'failed';
  /** Warnings raised before the failure, when any were. */
  warnings?: string[];
  error: OcrErrorPayload;
}

export type OcrMachineResult = OcrRunResult | OcrRunFailure;

export type OcrEventType =
  | 'run.started'
  | 'run.warning'
  | 'document.started'
  | 'document.progress'
  | 'document.completed'
  | 'document.partial'
  | 'document.failed'
  | 'document.skipped'
  | 'run.completed'
  | 'run.failed';

export type OcrProtocolStepKind =
  | 'runtime'
  | 'thought_summary'
  | 'reasoning'
  | 'model_output'
  | 'tool_call'
  | 'tool_result'
  | 'error';

export interface OcrProtocolStep {
  kind: OcrProtocolStepKind;
  status: 'started' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  stepId?: string;
  callId?: string;
  name?: string;
  text?: string;
  delta?: boolean;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: OcrErrorPayload;
}

export interface OcrJobEvent {
  protocolVersion: OcrProtocolVersion;
  type: OcrEventType;
  runId: string;
  sequence: number;
  timestamp: string;
  /** `run.warning` only: the same text that lands in the result's `warnings`. */
  message?: string;
  /** `run.failed` only: warnings raised before the run died, when any were. */
  warnings?: string[];
  total?: number;
  provider?: ProviderId;
  gateway?: GatewayId;
  model?: string;
  mode?: CliMode;
  dryRun?: boolean;
  documentId?: string;
  index?: number;
  source?: string;
  step?: OcrProtocolStep;
  document?: OcrProtocolDocument;
  /**
   * Present on `run.completed` only, and always the success branch: the event
   * schema points `result` at `result-v2#/$defs/success`, and a run that failed
   * reports itself through `run.failed`'s `error` instead. Typing this as the
   * wider {@link OcrMachineResult} let a failure envelope past the compiler and
   * into a runtime schema rejection.
   */
  result?: OcrRunResult;
  error?: OcrErrorPayload;
}

export type OcrJobEventSink = (event: OcrJobEvent) => void | Promise<void>;

export interface OcrCapabilities {
  protocolVersion: 2;
  supportedProtocolVersions: [2];
  cliVersion: string;
  operations: ['extract'];
  inputKinds: ['path', 'stdin', 'url'];
  modes: CliMode[];
  contentFormats: CliFormat[];
  responseFormats: ['json', 'jsonl'];
  deliveryModes: ['inline', 'reference'];
  progressLevels: ['off', 'standard', 'detailed'];
  progressStepKinds: OcrProtocolStepKind[];
  features: string[];
  errorCodes: OcrErrorCode[];
  exitCodes: {
    success: 0;
    incomplete: 1;
    invalid: 2;
    interrupted: 130;
    terminated: 143;
  };
  providers: Array<{
    id: ProviderId;
    label: string;
    defaultModel: string | null;
    models: string[];
    inputImageMimeTypes?: string[];
    capabilities: ProviderCapabilities;
    /**
     * Which `extraction.thinking` levels this route accepts, and what it uses
     * when the field is omitted.
     *
     * Published because the accepted set is narrower than the protocol's own
     * `thinking` enum and varies per model — Kimi K3 takes LOW/HIGH/MAX, Gemini
     * 3.1 Pro refuses MINIMAL — and an agent that guessed got a configuration
     * error it could only have avoided by reading prose. `fallbackLevels`
     * applies to any model ID not in `byModel`, which is how the profiles that
     * accept arbitrary upstream IDs are described.
     */
    reasoning?: {
      byModel: Record<string, {
        levels: ThinkingLevel[];
        defaultLevel: ThinkingLevel;
      }>;
      fallbackLevels: ThinkingLevel[];
    };
  }>;
  presets: Array<{
    id: string;
    label: string;
    description: string;
    outputShape: 'record' | 'table';
  }>;
  limits: {
    imageBytes: number;
    pdfBytes: number;
    pdfPages: number;
    customSchemaBytes: number;
    customSchemaDepth: number;
    /**
     * Every numeric request bound, so an agent never has to read the request
     * schema to learn a ceiling. Read from the same table the schema, the MCP
     * tool schemas, and the option resolver enforce.
     */
    request: Record<OcrRequestLimitKey, NumericRange>;
  };
  schemas: typeof OCR_PROTOCOL_SCHEMA_IDS;
  schemaAccess: {
    command: 'open-ocr-cli schema <name>';
    packageDirectory: 'schemas';
    networkFetch: false;
  };
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  // `verbose` attaches the failing subschema and the offending instance to every
  // error. validationMessage() needs both so it can name the field that broke and
  // read a union's allowed values straight off the schema instead of repeating
  // them in a hand-maintained list that would drift.
  verbose: true,
});
addFormats(ajv);
ajv.addSchema(errorV2Schema);
ajv.addSchema(resultV2Schema);
function requireValidator<T>(validator: ValidateFunction<T> | undefined, label: string): ValidateFunction<T> {
  if (!validator) throw new Error(`Could not compile the ${label} schema`);
  return validator;
}
const requestV2Validator: ValidateFunction<OcrJobRequest> = ajv.compile(requestV2Schema);
const resultV2Validator = requireValidator(ajv.getSchema<OcrMachineResult>(resultV2Schema.$id), 'OCR result v2');
const eventV2Validator: ValidateFunction<OcrJobEvent> = ajv.compile(eventV2Schema);
const capabilitiesValidator: ValidateFunction<OcrCapabilities> = ajv.compile(capabilitiesV2Schema);

/** Clauses kept in a validation message before the remainder is summarized. */
const MAX_VALIDATION_CLAUSES = 4;
/** Field names listed before an allowed-field list is truncated. */
const MAX_LISTED_FIELDS = 6;

/**
 * A union whose branches are told apart by one literal-valued property, such as
 * the `type` field that separates path, stdin and URL request inputs.
 */
interface UnionDiscriminator {
  field: string;
  /** Allowed values for each branch, indexed by branch position. */
  branchValues: string[][];
  /** Every allowed value across the union, in branch order. */
  values: string[];
}

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaProperties(schema: unknown): string[] {
  if (!isSchemaNode(schema)) return [];
  return isSchemaNode(schema.properties) ? Object.keys(schema.properties) : [];
}

function schemaRequired(schema: unknown): string[] {
  if (!isSchemaNode(schema)) return [];
  const required: unknown = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((name): name is string => typeof name === 'string');
}

/** The string values a subschema pins a property to, via `const` or `enum`. */
function schemaLiteralValues(schema: unknown): string[] | undefined {
  if (!isSchemaNode(schema)) return undefined;
  if (typeof schema.const === 'string') return [schema.const];
  const allowed: unknown = schema.enum;
  if (!Array.isArray(allowed) || allowed.length === 0) return undefined;
  const values = allowed.filter((value): value is string => typeof value === 'string');
  return values.length === allowed.length ? values : undefined;
}

function errorParamString(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Find the property that discriminates a union: required by every branch and
 * pinned to a literal in every branch. Returning the values from the schema is
 * what keeps the guidance honest when a branch is added or renamed.
 */
function unionDiscriminator(branches: unknown[]): UnionDiscriminator | undefined {
  if (branches.length < 2) return undefined;
  for (const field of schemaRequired(branches[0])) {
    const branchValues: string[][] = [];
    for (const branch of branches) {
      if (!schemaRequired(branch).includes(field)) break;
      const properties = isSchemaNode(branch) ? branch.properties : undefined;
      const values = schemaLiteralValues(isSchemaNode(properties) ? properties[field] : undefined);
      if (!values) break;
      branchValues.push(values);
    }
    if (branchValues.length === branches.length) {
      return { field, branchValues, values: [...new Set(branchValues.flat())] };
    }
  }
  return undefined;
}

/** Render a JSON Pointer instance path as `inputs[0].type`. */
function instanceLabel(instancePath: string): string {
  if (!instancePath) return '';
  return instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    .reduce<string>((label, segment) => {
      if (/^\d+$/u.test(segment)) return `${label}[${segment}]`;
      return label ? `${label}.${segment}` : segment;
    }, '');
}

function withInstanceLabel(instancePath: string, clause: string): string {
  const label = instanceLabel(instancePath);
  return label ? `${label}: ${clause}` : clause;
}

function fieldList(fields: string[]): string {
  if (fields.length <= MAX_LISTED_FIELDS) return fields.join(', ');
  return `${fields.slice(0, MAX_LISTED_FIELDS).join(', ')}, +${fields.length - MAX_LISTED_FIELDS} more`;
}

function quotedFields(fields: string[]): string {
  return fields.map((field) => `'${field}'`).join(', ');
}

function unknownFieldClause(fields: string[], allowed: string[]): string {
  const noun = fields.length === 1 ? 'unknown field' : 'unknown fields';
  const suffix = allowed.length > 0 ? ` — allowed fields: ${fieldList(allowed)}` : '';
  return `${noun} ${quotedFields(fields)}${suffix}`;
}

/** Turn a single non-union failure into a clause, preferring Ajv's own wording. */
function keywordClause(error: ErrorObject): string {
  if (error.keyword === 'enum') {
    const allowed: unknown = (error.params as Record<string, unknown>).allowedValues;
    if (Array.isArray(allowed)) return `must be one of: ${allowed.map((value) => String(value)).join(', ')}`;
  }
  if (error.keyword === 'const') {
    return `must be ${JSON.stringify((error.params as Record<string, unknown>).allowedValue)}`;
  }
  return error.message ?? 'is invalid';
}

/** The branch position an error came from, or undefined if it is not this union's. */
function unionBranchIndex(unionSchemaPath: string, schemaPath: string): number | undefined {
  if (!schemaPath.startsWith(`${unionSchemaPath}/`)) return undefined;
  const [segment] = schemaPath.slice(unionSchemaPath.length + 1).split('/');
  const index = Number.parseInt(segment, 10);
  return Number.isInteger(index) ? index : undefined;
}

/** Collapse every failure recorded against one instance path into few clauses. */
function instancePathClauses(instancePath: string, group: ErrorObject[]): string[] {
  const unknownFields: string[] = [];
  const missingFields: string[] = [];
  const otherClauses: string[] = [];
  let allowedFields: string[] = [];
  for (const error of group) {
    if (error.keyword === 'additionalProperties') {
      const field = errorParamString(error, 'additionalProperty');
      if (field && !unknownFields.includes(field)) unknownFields.push(field);
      if (allowedFields.length === 0) allowedFields = schemaProperties(error.parentSchema);
      continue;
    }
    if (error.keyword === 'required') {
      const field = errorParamString(error, 'missingProperty');
      if (field && !missingFields.includes(field)) missingFields.push(field);
      continue;
    }
    otherClauses.push(keywordClause(error));
  }
  const clauses: string[] = [];
  if (unknownFields.length > 0) clauses.push(unknownFieldClause(unknownFields, allowedFields));
  if (missingFields.length > 0) {
    const noun = missingFields.length === 1 ? 'missing required field' : 'missing required fields';
    clauses.push(`${noun} ${quotedFields(missingFields)}`);
  }
  clauses.push(...otherClauses);
  return clauses.map((clause) => withInstanceLabel(instancePath, clause));
}

/**
 * The discriminator is absent but one of the unknown fields carries a value the
 * discriminator would accept — the caller almost certainly used the wrong key.
 * `kind` is the discriminator everywhere else in this protocol, so agents reach
 * for it on inputs too; this is what turns that into a one-read fix.
 */
function renamedDiscriminatorField(
  data: Record<string, unknown>,
  discriminator: UnionDiscriminator,
  unknownFields: string[],
): string | undefined {
  if (data[discriminator.field] !== undefined) return undefined;
  return unknownFields.find((field) => {
    const value = data[field];
    return typeof value === 'string' && discriminator.values.includes(value);
  });
}

/** A union of plain type branches, e.g. `string | null`, reads best as one list. */
function unionTypeNames(unionError: ErrorObject, branchErrors: ErrorObject[]): string[] {
  const names: string[] = [];
  for (const error of branchErrors) {
    if (error.keyword !== 'type' || error.instancePath !== unionError.instancePath) return [];
    const name = errorParamString(error, 'type');
    if (!name) return [];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The branch that came closest to matching, used when nothing discriminates. */
function closestBranchErrors(unionError: ErrorObject, branchErrors: ErrorObject[]): ErrorObject[] {
  const byBranch = new Map<number, ErrorObject[]>();
  for (const error of branchErrors) {
    const index = unionBranchIndex(unionError.schemaPath, error.schemaPath);
    if (index === undefined) continue;
    const bucket = byBranch.get(index);
    if (bucket) bucket.push(error);
    else byBranch.set(index, [error]);
  }
  let closest: ErrorObject[] = [];
  for (const bucket of byBranch.values()) {
    if (closest.length === 0 || bucket.length < closest.length) closest = bucket;
  }
  return closest;
}

/**
 * Reduce a failed union to one actionable clause. Every branch fails whenever a
 * `oneOf` fails, so reporting each branch's complaints buries the real problem.
 */
function unionClauses(unionError: ErrorObject, branchErrors: ErrorObject[]): string[] {
  // Branches behind a `$ref` are reported by Ajv under their resolved schema
  // path rather than beneath the union, so those failures are already in the
  // error list and the union itself has nothing left to add.
  if (branchErrors.length === 0) return [];
  const branches: unknown[] = Array.isArray(unionError.schema) ? unionError.schema : [];
  const instancePath = unionError.instancePath;
  const discriminator = unionDiscriminator(branches);
  const data = isRecord(unionError.data) ? unionError.data : undefined;

  if (discriminator && data) {
    const selector = data[discriminator.field];
    if (typeof selector === 'string') {
      const matched = discriminator.branchValues
        .map((values, index) => (values.includes(selector) ? index : -1))
        .filter((index) => index >= 0);
      // The discriminator names exactly one branch, so only that branch matters.
      if (matched.length === 1) {
        const prefix = `${unionError.schemaPath}/${matched[0]}/`;
        const clauses = validationClauses(branchErrors.filter((error) => error.schemaPath.startsWith(prefix)));
        if (clauses.length > 0) return clauses;
      }
      return [withInstanceLabel(
        instancePath,
        `${discriminator.field} must be one of: ${discriminator.values.join(', ')}`,
      )];
    }
  }

  const knownFields = [...new Set(branches.flatMap((branch) => schemaProperties(branch)))];
  // With no declared properties there is nothing to call an unknown field against.
  const unknownFields = data && knownFields.length > 0
    ? Object.keys(data).filter((field) => !knownFields.includes(field))
    : [];
  if (unknownFields.length > 0) {
    const renamed = discriminator && data
      ? renamedDiscriminatorField(data, discriminator, unknownFields)
      : undefined;
    if (renamed && discriminator) {
      const hint = unknownFields.length === 1
        ? `did you mean '${discriminator.field}'?`
        : `did you mean '${discriminator.field}' instead of '${renamed}'?`;
      const noun = unknownFields.length === 1 ? 'unknown field' : 'unknown fields';
      return [withInstanceLabel(
        instancePath,
        `${noun} ${quotedFields(unknownFields)} — ${hint} (${discriminator.field} must be one of: ${discriminator.values.join(', ')})`,
      )];
    }
    return [withInstanceLabel(instancePath, unknownFieldClause(unknownFields, knownFields))];
  }

  if (discriminator) {
    return [withInstanceLabel(
      instancePath,
      `missing required field '${discriminator.field}' — must be one of: ${discriminator.values.join(', ')}`,
    )];
  }

  const typeNames = unionTypeNames(unionError, branchErrors);
  if (typeNames.length > 1) return [withInstanceLabel(instancePath, `must be ${typeNames.join(' or ')}`)];

  const closest = closestBranchErrors(unionError, branchErrors);
  const closestClauses = closest.length > 0 ? validationClauses(closest) : [];
  if (closestClauses.length > 0) return closestClauses;
  return [withInstanceLabel(instancePath, unionError.message ?? 'is invalid')];
}

/**
 * Build the clause list for a set of Ajv errors, collapsing unions and merging
 * everything else by instance path so each clause names one actionable problem.
 */
function validationClauses(allErrors: ErrorObject[]): string[] {
  // An `if` failure only restates that its `then`/`else` branch failed, and that
  // branch reports itself.
  const errors = allErrors.filter((error) => error.keyword !== 'if');
  // Outermost unions first, so a union swallows any nested union beneath it.
  const unionErrors = errors
    .filter((error) => error.keyword === 'oneOf' || error.keyword === 'anyOf')
    .sort((left, right) => left.schemaPath.length - right.schemaPath.length);
  const consumed = new Set<ErrorObject>();
  const branchesByUnion = new Map<ErrorObject, ErrorObject[]>();
  for (const unionError of unionErrors) {
    if (consumed.has(unionError)) continue;
    const owned = errors.filter((error) => (
      error !== unionError
      && !consumed.has(error)
      && error.schemaPath.startsWith(`${unionError.schemaPath}/`)
    ));
    for (const error of owned) consumed.add(error);
    branchesByUnion.set(unionError, owned);
  }

  // Emit each union and each instance-path group where its first error appeared.
  const renderers: Array<() => string[]> = [];
  const groupsByPath = new Map<string, ErrorObject[]>();
  for (const error of errors) {
    if (consumed.has(error)) continue;
    const owned = branchesByUnion.get(error);
    if (owned) {
      renderers.push(() => unionClauses(error, owned));
      continue;
    }
    const group = groupsByPath.get(error.instancePath);
    if (group) {
      group.push(error);
      continue;
    }
    const started = [error];
    groupsByPath.set(error.instancePath, started);
    renderers.push(() => instancePathClauses(error.instancePath, started));
  }
  return [...new Set(renderers.flatMap((render) => render()))];
}

/**
 * Render Ajv failures as a short, single-line, machine-parseable explanation.
 *
 * Validation errors are the CLI's front door for coding agents, so a message
 * has to name the offending field and the fix rather than replay every branch
 * a union tried.
 */
function validationMessage(errors: ErrorObject[] | null | undefined): string {
  const reported = errors ?? [];
  const collapsed = validationClauses(reported);
  const clauses = collapsed.length > 0
    ? collapsed
    : [...new Set(reported.map((error) => withInstanceLabel(error.instancePath, error.message ?? 'is invalid')))];
  if (clauses.length === 0) return 'is invalid';
  const shown = clauses.slice(0, MAX_VALIDATION_CLAUSES);
  const remaining = clauses.length - shown.length;
  const message = remaining > 0
    ? `${shown.join('; ')}; (+${remaining} more ${remaining === 1 ? 'issue' : 'issues'})`
    : shown.join('; ');
  return message.replace(/\s+/gu, ' ').trim();
}

/**
 * @param label Human-readable subject of the failure, e.g. `Invalid OCR event`.
 * @param schemaName The `open-ocr-cli schema <name>` argument that prints the
 *   schema this payload failed against. Kept separate from `label` because the
 *   hint names a command to run: interpolating the label produced advice like
 *   "the bundled invalid ocr event v2 schema", naming a schema that does not
 *   exist and that `schema <name>` rejects.
 */
function assertValid<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
  schemaName: 'request' | 'result' | 'event' | 'capabilities',
): asserts value is T {
  if (validator(value)) return;
  const requestPayload = schemaName === 'request';
  throw new CliExitError(`${label}: ${validationMessage(validator.errors)}`, 2, {
    code: requestPayload ? 'CONFIG_INVALID' : 'SCHEMA_INVALID',
    category: requestPayload ? 'configuration' : 'schema',
    retryable: false,
    hint: `Compare the payload with the bundled schema: open-ocr-cli schema ${schemaName}.`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface OcrExtractionSemantics {
  mode?: string;
  preset?: string;
  hasSchema: boolean;
  contentFormat?: string;
}

/**
 * Output shape per shipped preset, the same data `capabilities` publishes.
 *
 * A record-shaped preset extracts one row's worth of fields, so it can never
 * emit CSV. Reading the shape here is what lets that combination be refused
 * before a billed provider call instead of after one.
 */
const PRESET_OUTPUT_SHAPES: ReadonlyMap<string, 'record' | 'table'> = new Map(
  listExtractionPresets().map((preset) => [preset.id, preset.outputShape]),
);

const TABLE_PRESET_IDS: readonly string[] = [...PRESET_OUTPUT_SHAPES]
  .filter(([, shape]) => shape === 'table')
  .map(([id]) => id);

/**
 * CSV output requires a preset that produces rows.
 *
 * Unknown presets fall through: naming them is the job of the preset lookup,
 * which reports the supported ids. resolveCliOptions states the same rule in
 * flag vocabulary; the two wordings are kept parallel so an agent reading
 * either one learns the same thing.
 */
function csvPresetShapeError(preset: string): string | undefined {
  if (PRESET_OUTPUT_SHAPES.get(preset) !== 'record') return undefined;
  return `OCR extraction.preset ${preset} extracts a single record per document, so it cannot produce CSV rows. `
    + `Use extraction.contentFormat json or markdown, or a table preset: ${TABLE_PRESET_IDS.join(', ')}.`;
}

/**
 * Validate compatibility between the output-affecting extraction options.
 *
 * This deliberately accepts strings instead of already-narrowed CLI types so
 * it can validate both a raw protocol request and the effective request after
 * file configuration has been merged.
 */
export function ocrExtractionSemanticError(
  extraction: OcrExtractionSemantics,
): string | undefined {
  const { mode, preset, hasSchema, contentFormat } = extraction;
  const hasPreset = preset !== undefined;
  if (hasPreset && hasSchema) {
    return 'OCR extraction.preset cannot be combined with extraction.schema or extraction.schemaPath.';
  }
  if (mode === 'template' && !hasPreset) {
    return 'OCR extraction.preset is required when extraction.mode is template.';
  }
  if (hasPreset && mode !== undefined && mode !== 'template') {
    return 'OCR extraction.preset requires extraction.mode to be template or omitted.';
  }
  if (hasSchema && mode !== undefined && mode !== 'simple') {
    return 'OCR custom schemas require extraction.mode to be simple or omitted.';
  }
  if (hasSchema && contentFormat !== undefined && contentFormat !== 'json') {
    return 'OCR custom schemas require extraction.contentFormat to be json or omitted.';
  }
  if (contentFormat === 'csv' && mode !== 'template' && !(mode === undefined && hasPreset)) {
    return 'OCR extraction.contentFormat csv requires template mode and a preset.';
  }
  if (contentFormat === 'csv' && preset !== undefined) {
    const shapeError = csvPresetShapeError(preset);
    if (shapeError) return shapeError;
  }
  return undefined;
}

/**
 * Validate the extraction restrictions that apply when every input is a URL.
 *
 * Fields are `unknown` so this can run before JSON Schema validation on a raw
 * request as well as on the config-merged effective request.
 */
export function ocrUrlExtractionSemanticError(extraction: {
  mode?: unknown;
  preset?: unknown;
  hasSchema: boolean;
  contentFormat?: unknown;
}): string | undefined {
  const unsupportedMode = extraction.mode !== undefined && extraction.mode !== 'simple';
  const unsupportedFormat = extraction.contentFormat !== undefined
    && extraction.contentFormat !== 'markdown'
    && extraction.contentFormat !== 'json';
  if (unsupportedMode || extraction.preset !== undefined || extraction.hasSchema || unsupportedFormat) {
    return 'OCR URL inputs support simple mode with markdown or JSON output only.';
  }
  return undefined;
}

/**
 * Inline delivery is response-only, so the file-placement fields have nothing
 * to act on.
 *
 * The request schemas already forbid the combination, but a failing `not`
 * keyword renders as `delivery: must NOT be valid`, which names neither field
 * nor the conflict. Catching it here — semantic checks run before schema
 * validation — is what makes the failure self-correcting on `run` and MCP
 * alike, without touching the frozen schemas.
 */
function deliverySemanticError(delivery: unknown): string | undefined {
  if (!isRecord(delivery) || delivery.mode !== 'inline') return undefined;
  const conflicting = ['outputDirectory', 'resume'].filter((field) => delivery[field] !== undefined);
  if (conflicting.length === 0) return undefined;
  const fields = conflicting.map((field) => `delivery.${field}`).join(' and ');
  return `OCR ${fields} cannot be combined with delivery.mode inline: inline delivery returns content in the `
    + 'response and writes no artifact files. Set delivery.mode to reference to write artifacts to '
    + `outputDirectory, or drop ${fields}.`;
}

function requestSemanticError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.noConfig === true && typeof value.configPath === 'string') {
    return 'OCR request noConfig and configPath are mutually exclusive.';
  }
  const deliveryError = deliverySemanticError(value.delivery);
  if (deliveryError) return deliveryError;
  if (Array.isArray(value.inputs)) {
    const stdinInputs = value.inputs.filter(isStdinRequestInput);
    if (stdinInputs.length > 0 && value.inputs.length !== 1) {
      return 'An OCR stdin document must be the request\'s only input.';
    }
    const urlInputs = value.inputs.filter((input) => isRecord(input) && input.type === 'url');
    if (urlInputs.length > 0 && urlInputs.length !== value.inputs.length) {
      return 'OCR URL inputs cannot be mixed with path or stdin inputs.';
    }
    if (urlInputs.length > OCR_REQUEST_LIMITS.urlInputs.max) {
      return `Web OCR supports at most ${OCR_REQUEST_LIMITS.urlInputs.max} URLs per request; received ${urlInputs.length}.`;
    }
    if (urlInputs.length === 0 && isRecord(value.web)) {
      return 'OCR request web options require URL inputs.';
    }
    if (urlInputs.length > 0 && isRecord(value.extraction)) {
      const extraction = value.extraction;
      const urlError = ocrUrlExtractionSemanticError({
        mode: extraction.mode,
        preset: extraction.preset,
        hasSchema: isRecord(extraction.schema) || typeof extraction.schemaPath === 'string',
        contentFormat: extraction.contentFormat,
      });
      if (urlError) return urlError;
    }
  }
  if (!isRecord(value.extraction)) return undefined;
  const extraction = value.extraction;
  const hasSchema = isRecord(extraction.schema) || typeof extraction.schemaPath === 'string';
  const preset = typeof extraction.preset === 'string' ? extraction.preset : undefined;
  const mode = typeof extraction.mode === 'string' ? extraction.mode : undefined;
  const format = typeof extraction.contentFormat === 'string' ? extraction.contentFormat : undefined;
  if (isRecord(extraction.schema) && typeof extraction.schemaPath === 'string') {
    return 'OCR request extraction.schema and extraction.schemaPath are mutually exclusive.';
  }
  return ocrExtractionSemanticError({
    mode,
    preset,
    hasSchema,
    contentFormat: format,
  });
}

export function parseOcrJobRequest(value: unknown): OcrJobRequest {
  const version = isRecord(value) ? value.protocolVersion : undefined;
  if (version !== OCR_PROTOCOL_VERSION) {
    throw new CliExitError(`Unsupported OCR protocol version: ${String(version)}`, 2, {
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
      hint: `Use protocolVersion ${OCR_PROTOCOL_VERSION} and inspect the bundled request schema.`,
    });
  }
  const semanticError = requestSemanticError(value);
  if (semanticError) {
    throw new CliExitError(semanticError, 2, {
      code: 'CONFIG_INVALID',
      category: 'configuration',
      retryable: false,
      hint: 'Adjust the extraction fields and validate the request again before running OCR.',
    });
  }
  assertValid(requestV2Validator, value, 'Invalid OCR request', 'request');
  return value;
}

export function assertOcrMachineResult(value: unknown): asserts value is OcrMachineResult {
  assertValid(resultV2Validator, value, 'Invalid OCR result', 'result');
}

export function assertOcrJobEvent(value: unknown): asserts value is OcrJobEvent {
  assertValid(eventV2Validator, value, 'Invalid OCR event', 'event');
}

export function assertOcrCapabilities(value: unknown): asserts value is OcrCapabilities {
  assertValid(capabilitiesValidator, value, 'Invalid OCR capabilities', 'capabilities');
}

const ARTIFACT_MEDIA_TYPES: Record<ArtifactExtension, Pick<OcrArtifactReference, 'mediaType' | 'kind'>> = {
  md: { mediaType: 'text/markdown', kind: 'markdown' },
  json: { mediaType: 'application/json', kind: 'json' },
  csv: { mediaType: 'text/csv', kind: 'csv' },
  'steps.json': { mediaType: 'application/json', kind: 'agent-steps' },
};

/**
 * Describe an artifact by what was written into it, not by what its name ends
 * with. `--output report.json --format markdown` is a legal request that puts
 * Markdown in a `.json` file; reading the extension back told the caller it was
 * JSON.
 */
function artifactReference(target: ArtifactTarget): OcrArtifactReference {
  return { path: target.path, ...ARTIFACT_MEDIA_TYPES[target.extension] };
}

export function agentProtocolStep(
  step: AgentStep,
  progress: OcrProgressLevel,
): OcrProtocolStep | undefined {
  if (progress === 'off') return undefined;
  const source = step.source ?? (
    step.type === 'function_call'
      ? 'tool_call'
      : step.functionResult ? 'tool_result' : 'runtime'
  );
  if (source === 'reasoning' && progress !== 'detailed') return undefined;
  if (step.delta && !step.id) {
    throw new Error('Streaming agent progress requires a stable step ID');
  }
  if (source === 'tool_call') {
    const callId = step.functionCall?.id;
    const name = step.functionCall?.name;
    if (!callId || !name) {
      throw new Error('Tool-call progress requires a call ID and function name');
    }
    return {
      kind: 'tool_call',
      status: 'started',
      ...(step.id ? { stepId: step.id } : {}),
      callId,
      name,
      ...(progress === 'detailed' && step.functionCall?.arguments
        ? { arguments: step.functionCall.arguments }
        : {}),
    };
  }
  if (source === 'tool_result') {
    const callId = step.functionCall?.id;
    const name = step.functionCall?.name;
    if (!callId || !name) {
      throw new Error('Tool-result progress requires a call ID and function name');
    }
    return {
      kind: 'tool_result',
      status: step.functionResult?.success === false ? 'failed' : 'completed',
      ...(step.id ? { stepId: step.id } : {}),
      callId,
      name,
      ...(progress === 'detailed' && step.functionResult !== undefined
        ? { result: step.functionResult }
        : {}),
    };
  }
  const kind = source === 'thought_summary'
    || source === 'reasoning'
    || source === 'model_output'
    ? source
    : step.type === 'error' ? 'error' : 'runtime';
  return {
    kind,
    status: step.type === 'error'
      ? 'failed'
      : step.delta ? 'in_progress' : 'completed',
    ...(step.id ? { stepId: step.id } : {}),
    text: step.content,
    ...(step.delta ? { delta: true } : {}),
  };
}

export function ocrDocumentId(result: Pick<OcrJobResult, 'input'>): string {
  const identity = result.input.absolutePath
    ?? `${result.input.displayPath}:${result.input.relativePath}:${result.input.size}:${result.input.mtimeMs}`;
  const hash = createHash('sha256').update(identity);
  if (result.input.stdinBytes) hash.update('\0stdin-bytes\0').update(result.input.stdinBytes);
  return hash.digest('hex').slice(0, 16);
}

function inlineContent(
  result: OcrJobResult,
  contentFormat: CliFormat,
  progress: OcrProgressLevel,
): OcrProtocolDocument['content'] | undefined {
  if (!result.artifacts) return undefined;
  const content = {
    ...((contentFormat === 'markdown' || contentFormat === 'all')
      && result.artifacts.markdown !== undefined ? { markdown: result.artifacts.markdown } : {}),
    ...((contentFormat === 'json' || contentFormat === 'all')
      && result.artifacts.json !== undefined ? { json: result.artifacts.json } : {}),
    ...((contentFormat === 'csv' || contentFormat === 'all')
      && result.artifacts.csv !== undefined ? { csv: result.artifacts.csv } : {}),
    ...(contentFormat === 'all' && result.artifacts.agentSteps !== undefined
      ? {
          agentSteps: result.artifacts.agentSteps
            .map((step) => agentProtocolStep(step, progress))
            .filter((step): step is OcrProtocolStep => step !== undefined),
        }
      : {}),
  };
  return Object.keys(content).length > 0 ? content : undefined;
}

export function toProtocolDocument(
  result: OcrJobResult,
  deliveryMode: OcrDeliveryMode = 'reference',
  contentFormat: CliFormat = 'all',
  progress: OcrProgressLevel = 'standard',
): OcrProtocolDocument {
  if (!result.provider || !result.gateway) throw new Error('Protocol documents require provider and gateway metadata');
  const content = deliveryMode === 'inline'
    ? inlineContent(result, contentFormat, progress)
    : undefined;
  return {
    documentId: ocrDocumentId(result),
    source: result.input.displayPath,
    status: result.status,
    mode: result.mode,
    provider: result.provider,
    gateway: result.gateway,
    model: result.model,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    attempts: result.attempts,
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
    ...(result.partialReason ? { partialReason: result.partialReason } : {}),
    ...(result.nextAction ? { nextAction: result.nextAction } : {}),
    artifacts: (result.outputArtifacts ?? []).map(artifactReference),
    plannedArtifacts: (result.plannedOutputArtifacts ?? []).map(artifactReference),
    ...(content
      ? { content }
      : {}),
    ...(result.errorDetails ? { error: result.errorDetails } : {}),
  };
}

function runStatus(summary: BatchSummary): OcrRunResult['status'] {
  if (summary.costLimitReached) return 'cost_limited';
  if (summary.results.some((result) => result.skipReason === 'cancelled')) return 'cancelled';
  if (summary.results.every((result) => result.skipReason === 'validated')) return 'validated';
  if (summary.failed > 0) {
    const hasUsableResult = summary.succeeded > 0
      || summary.partial > 0
      || summary.results.some((result) => (
        result.skipReason === 'resumed' || result.skipReason === 'validated'
      ));
    return hasUsableResult ? 'partial' : 'failed';
  }
  if (summary.partial > 0) return 'partial';
  return 'succeeded';
}

export function toOcrRunResult(
  runId: string,
  summary: BatchSummary,
  deliveryMode: OcrDeliveryMode = 'reference',
  contentFormat: CliFormat = 'all',
  progress: OcrProgressLevel = 'standard',
  warnings: readonly string[] = [],
): OcrRunResult {
  if (!summary.provider || !summary.gateway) throw new Error('Protocol results require provider and gateway metadata');
  const status = runStatus(summary);
  const result: OcrRunResult = {
    protocolVersion: OCR_PROTOCOL_VERSION,
    type: 'run.result',
    ok: status === 'succeeded' || status === 'validated',
    runId,
    status,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationMs: summary.durationMs,
    total: summary.total,
    succeeded: summary.succeeded,
    partial: summary.partial,
    failed: summary.failed,
    skipped: summary.skipped,
    mode: summary.mode,
    provider: summary.provider,
    gateway: summary.gateway,
    model: summary.model,
    usage: summary.usage,
    ...(summary.costLimitUsd !== undefined ? { costLimitUsd: summary.costLimitUsd } : {}),
    costLimitReached: summary.costLimitReached,
    warnings: [...warnings],
    documents: summary.results.map((document) => (
      toProtocolDocument(document, deliveryMode, contentFormat, progress)
    )),
  };
  assertOcrMachineResult(result);
  return result;
}

export function toOcrRunFailure(
  runId: string,
  error: OcrErrorPayload,
  warnings: readonly string[] = [],
): OcrRunFailure {
  const result: OcrRunFailure = {
    protocolVersion: OCR_PROTOCOL_VERSION,
    type: 'run.result',
    ok: false,
    runId,
    status: 'failed',
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    error,
  };
  assertOcrMachineResult(result);
  return result;
}

export function createOcrCapabilities(cliVersion: string): OcrCapabilities {
  const capabilities: OcrCapabilities = {
    protocolVersion: OCR_PROTOCOL_VERSION,
    supportedProtocolVersions: [OCR_PROTOCOL_VERSION],
    cliVersion,
    operations: ['extract'],
    inputKinds: ['path', 'stdin', 'url'],
    modes: ['simple', 'template', 'agentic'],
    contentFormats: ['markdown', 'json', 'csv', 'all'],
    responseFormats: ['json', 'jsonl'],
    deliveryModes: ['inline', 'reference'],
    progressLevels: ['off', 'standard', 'detailed'],
    progressStepKinds: [
      'runtime',
      'thought_summary',
      'reasoning',
      'model_output',
      'tool_call',
      'tool_result',
      'error',
    ],
    features: [
      'custom-json-schema',
      'credential-free-dry-run',
      'ordered-jsonl-events',
      'typed-streaming-agent-progress',
      'provider-reasoning-continuity',
      'inline-or-reference-delivery',
      'reference-first-artifacts',
      'resume',
      'request-rate-limit',
      'cost-limit',
      'typed-errors',
      'stdin-input',
      'url-input',
      'hermetic-config',
      'mcp-stdio',
      'result-warnings',
    ],
    errorCodes: [...OCR_ERROR_CODES],
    exitCodes: {
      success: 0,
      incomplete: 1,
      invalid: 2,
      interrupted: 130,
      terminated: 143,
    },
    providers: Object.values(PROVIDER_PROFILES).map((profile) => ({
      id: profile.id,
      label: profile.label,
      defaultModel: profile.defaultModel ?? null,
      models: [...profile.models],
      ...(profile.inputImageMimeTypes
        ? { inputImageMimeTypes: [...profile.inputImageMimeTypes] }
        : {}),
      capabilities: profile.capabilities,
      ...(profile.capabilities.reasoning === false || profile.capabilities.reasoning === 'unknown'
        ? {}
        : {
            reasoning: {
              byModel: Object.fromEntries(profile.models.map((model) => [model, {
                levels: [...cliThinkingLevels(profile.id, model)],
                defaultLevel: defaultCliThinkingLevel(profile.id, model),
              }])),
              // The list an unrecognised upstream model ID gets. Read from a
              // model name no profile declares, so it reports the genuine
              // fallback rather than a copy that could drift from the resolver.
              fallbackLevels: [...cliThinkingLevels(profile.id, '')],
            },
          }),
    })),
    presets: listExtractionPresets().map((preset) => ({
      id: preset.id,
      label: preset.label,
      description: preset.description,
      outputShape: preset.outputShape,
    })),
    limits: {
      imageBytes: FILE_CONSTRAINTS.MAX_IMAGE_SIZE,
      pdfBytes: FILE_CONSTRAINTS.MAX_PDF_SIZE,
      pdfPages: FILE_CONSTRAINTS.MAX_PDF_PAGES,
      customSchemaBytes: 1024 * 1024,
      customSchemaDepth: 32,
      request: Object.fromEntries(
        Object.entries(OCR_REQUEST_LIMITS).map(([key, range]) => [key, { ...range }]),
      ) as Record<OcrRequestLimitKey, NumericRange>,
    },
    schemas: OCR_PROTOCOL_SCHEMA_IDS,
    schemaAccess: {
      command: 'open-ocr-cli schema <name>',
      packageDirectory: 'schemas',
      networkFetch: false,
    },
  };
  assertOcrCapabilities(capabilities);
  return capabilities;
}

export function defaultAgentOutputDirectory(cwd: string, runId: string): string {
  return path.join(cwd, '.open-ocr-results', runId);
}
