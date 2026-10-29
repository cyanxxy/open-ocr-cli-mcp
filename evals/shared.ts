import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EXTENSION_TO_MIME } from '@open-ocr/engine/constants';
import {
  validateEvalCase,
  validateEvalSuiteConfig,
  type EvalCase,
  type EvalGroundTruth,
  type EvalRunOutput,
  type EvalRunSummary,
  type EvalSuiteConfig,
  type EvalSuiteName,
} from '@open-ocr/engine/evals';
import { isOcrUnitTest } from '@open-ocr/engine/evalUnitTests';

const evalsDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(evalsDir, '..');
export const reportsDir = path.resolve(repoRoot, 'evals', 'reports');

async function listCaseFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory))
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => path.resolve(directory, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function loadEvalCases(suite: EvalSuiteName = 'full'): Promise<EvalCase[]> {
  const caseFiles = [
    ...await listCaseFiles(path.resolve(repoRoot, 'evals', 'cases')),
    ...await listCaseFiles(path.resolve(repoRoot, 'evals', 'cache', 'cases')),
  ];
  const cases = await Promise.all(caseFiles.map(async (filePath) => {
    const raw = await fs.readFile(filePath, 'utf8');
    return validateEvalCase(JSON.parse(raw));
  }));
  const duplicateIds = cases.filter((evalCase, index) => cases.findIndex((candidate) => candidate.id === evalCase.id) !== index);
  if (duplicateIds.length > 0) throw new Error(`Duplicate eval case id: ${duplicateIds[0].id}`);
  return cases.filter((evalCase) => evalCase.suites.includes(suite));
}

export async function loadEvalSuiteConfig(): Promise<EvalSuiteConfig> {
  const configPath = path.resolve(repoRoot, 'evals', 'config.json');

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return validateEvalSuiteConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function assertEvalInputsExist(evalCases: EvalCase[]): Promise<void> {
  for (const evalCase of evalCases) {
    const absoluteInputPath = path.resolve(repoRoot, evalCase.inputPath);
    await fs.access(absoluteInputPath);
    if (evalCase.reference?.textPath) await fs.access(path.resolve(repoRoot, evalCase.reference.textPath));
    if (evalCase.reference?.jsonPath) await fs.access(path.resolve(repoRoot, evalCase.reference.jsonPath));
    if (evalCase.reference?.unitTestsPath) await fs.access(path.resolve(repoRoot, evalCase.reference.unitTestsPath));
  }
}

export async function loadEvalGroundTruth(evalCase: EvalCase): Promise<EvalGroundTruth | undefined> {
  if (!evalCase.reference) return undefined;
  const groundTruth: EvalGroundTruth = {};
  if (evalCase.reference.textPath) {
    groundTruth.text = await fs.readFile(path.resolve(repoRoot, evalCase.reference.textPath), 'utf8');
  }
  if (evalCase.reference.jsonPath) {
    const raw = await fs.readFile(path.resolve(repoRoot, evalCase.reference.jsonPath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Eval reference JSON must be an object: ${evalCase.reference.jsonPath}`);
    }
    groundTruth.json = parsed as Record<string, unknown>;
  }
  if (evalCase.reference.unitTestsPath) {
    const raw = await fs.readFile(path.resolve(repoRoot, evalCase.reference.unitTestsPath), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isOcrUnitTest)) {
      throw new Error(`Eval unit tests must be a non-empty array of valid tests: ${evalCase.reference.unitTestsPath}`);
    }
    groundTruth.unitTests = parsed;
  }
  return groundTruth;
}

export function detectMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = EXTENSION_TO_MIME[extension];
  if (!mimeType) {
    throw new Error(`Unsupported eval input extension: ${extension}`);
  }
  return mimeType;
}

export async function fileToDataUrl(relativePath: string): Promise<{ dataUrl: string; mimeType: string }> {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const mimeType = detectMimeType(absolutePath);
  const bytes = await fs.readFile(absolutePath);
  return {
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    mimeType,
  };
}

export async function writeEvalSummary(summary: EvalRunSummary, markdown: string): Promise<void> {
  await fs.mkdir(reportsDir, { recursive: true });
  await fs.writeFile(path.resolve(reportsDir, 'latest.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.resolve(reportsDir, 'latest.md'), markdown, 'utf8');
}

export interface EvalArtifact {
  evalCase: EvalCase;
  output: EvalRunOutput;
  repeatIndex?: number;
}

export async function writeEvalArtifacts(summary: EvalRunSummary, artifacts: EvalArtifact[]): Promise<string> {
  const runId = summary.runAt.replace(/[:.]/g, '-');
  const runDirectory = path.resolve(reportsDir, 'runs', runId);
  await fs.mkdir(runDirectory, { recursive: true });
  await Promise.all(artifacts.map(async ({ evalCase, output, repeatIndex }) => {
    const repeatSuffix = repeatIndex == null ? '' : `-repeat-${repeatIndex + 1}`;
    await fs.writeFile(
      path.resolve(runDirectory, `${evalCase.id}${repeatSuffix}.json`),
      `${JSON.stringify({ case: evalCase, output }, null, 2)}\n`,
      'utf8',
    );
  }));
  await fs.writeFile(path.resolve(runDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return runDirectory;
}

export function resolveSuiteName(argv: string[] = process.argv.slice(2)): EvalSuiteName {
  const suiteIndex = argv.indexOf('--suite');
  const suite = suiteIndex >= 0 ? argv[suiteIndex + 1] : 'full';
  if (suite !== 'canary' && suite !== 'full' && suite !== 'benchmark') {
    throw new Error(`Unsupported eval suite: ${suite}`);
  }
  return suite;
}

export function resolveRepeatCount(argv: string[] = process.argv.slice(2)): number {
  const repeatIndex = argv.indexOf('--repeat');
  const rawValue = repeatIndex >= 0 ? argv[repeatIndex + 1] : (process.env.EVAL_REPEATS ?? '1');
  const repeats = Number(rawValue);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) {
    throw new Error(`Eval repeat count must be an integer from 1 to 10, received: ${rawValue}`);
  }
  return repeats;
}
