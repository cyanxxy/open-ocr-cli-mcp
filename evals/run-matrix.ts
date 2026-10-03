import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import type { EvalRunSummary } from '@open-ocr/engine/evals';
import { GATEWAY_IDS, PROVIDER_IDS } from '@open-ocr/engine/providers';
import { repoRoot, reportsDir, resolveSuiteName } from './shared';

interface MatrixEntry {
  id: string;
  provider: string;
  model: string;
  gateway?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  cloudflareProvider?: string;
}

interface MatrixConfig {
  providers: MatrixEntry[];
}

interface MatrixResult {
  entry: MatrixEntry;
  exitCode: number;
  summary?: EvalRunSummary;
  error?: string;
}

class MatrixCancelledError extends Error {
  readonly exitCode: number;

  constructor(readonly signal: NodeJS.Signals) {
    super(`Evaluation matrix cancelled by ${signal}`);
    this.exitCode = 128 + (osConstants.signals[signal] ?? 0);
  }
}

/** Join the process before scheduling another provider, including cancellation. */
export function waitForMatrixChild(child: ChildProcess, signal: AbortSignal): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal.reason instanceof MatrixCancelledError ? signal.reason.signal : 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 3000);
      killTimer.unref();
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, childSignal) => {
      cleanup();
      if (signal.aborted) {
        reject(signal.reason);
      } else if (childSignal) {
        // A terminated worker is cancellation, not an ordinary failed score.
        // Continuing would launch more paid work after a user stopped a run.
        reject(new MatrixCancelledError(childSignal));
      } else {
        resolve(code ?? 1);
      }
    });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function runChild(entry: MatrixEntry, suite: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const child = spawn(process.execPath, ['--import', 'tsx', 'evals/run.ts', '--suite', suite], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      EVAL_PROVIDER: entry.provider,
      EVAL_GATEWAY: entry.gateway ?? 'direct',
      OPEN_OCR_MODEL: entry.model,
      ...(entry.apiKeyEnv ? { EVAL_API_KEY_ENV: entry.apiKeyEnv } : {}),
      ...(entry.baseUrl ? { OPEN_OCR_BASE_URL: entry.baseUrl } : {}),
      ...(entry.cloudflareProvider ? { CLOUDFLARE_AI_GATEWAY_PROVIDER: entry.cloudflareProvider } : {}),
    },
  });
  return waitForMatrixChild(child, signal);
}

export function parseMatrixConfig(value: unknown): MatrixConfig {
  if (typeof value !== 'object' || value === null || !('providers' in value)
    || !Array.isArray(value.providers) || value.providers.length === 0) {
    throw new Error('Eval matrix config must contain a non-empty providers array');
  }
  const ids = new Set<string>();
  const providers = value.providers.map((entry: unknown): MatrixEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('Every matrix provider must be an object');
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(record.id)) {
      throw new Error('Matrix provider id must be 1–80 letters, digits, underscores, or hyphens, starting with a letter or digit');
    }
    const key = record.id.toLowerCase();
    if (ids.has(key)) throw new Error(`Eval matrix provider id must be unique: ${record.id}`);
    ids.add(key);
    if (typeof record.provider !== 'string' || !PROVIDER_IDS.includes(record.provider as (typeof PROVIDER_IDS)[number])) {
      throw new Error(`Unsupported matrix provider: ${String(record.provider)}`);
    }
    if (record.gateway !== undefined && (typeof record.gateway !== 'string' || !GATEWAY_IDS.includes(record.gateway as (typeof GATEWAY_IDS)[number]))) {
      throw new Error(`Unsupported matrix gateway: ${String(record.gateway)}`);
    }
    if (typeof record.model !== 'string' || !record.model.trim()) throw new Error(`Matrix entry ${record.id} requires a model`);
    for (const optional of ['apiKeyEnv', 'baseUrl', 'cloudflareProvider']) {
      if (record[optional] !== undefined && (typeof record[optional] !== 'string' || !record[optional].trim())) {
        throw new Error(`Matrix entry ${record.id} requires ${optional} to be a non-empty string`);
      }
    }
    return {
      id: record.id, provider: record.provider, model: record.model,
      ...(typeof record.gateway === 'string' ? { gateway: record.gateway } : {}),
      ...(typeof record.apiKeyEnv === 'string' ? { apiKeyEnv: record.apiKeyEnv } : {}),
      ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
      ...(typeof record.cloudflareProvider === 'string' ? { cloudflareProvider: record.cloudflareProvider } : {}),
    };
  });
  return { providers };
}

function matrixMarkdown(results: MatrixResult[], suite: string): string {
  return `${[
    '# Multi-provider OCR Evaluation',
    '',
    `Suite: \`${suite}\``,
    '',
    '| Run | Provider | Gateway | Model | Cases | Pass rate | Score | Status |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...results.map(({ entry, summary, exitCode }) => `| ${[
      entry.id,
      entry.provider,
      entry.gateway ?? 'direct',
      `\`${entry.model}\``,
      summary?.totalCases ?? '-',
      summary ? `${(summary.passRate * 100).toFixed(1)}%` : '-',
      summary ? `${(summary.weightedScore * 100).toFixed(1)}%` : '-',
      exitCode === 0 ? 'passed' : summary?.status ?? 'runtime failed',
    ].join(' | ')} |`),
    '',
  ].join('\n')}\n`;
}

async function main(signal: AbortSignal): Promise<void> {
  const suite = resolveSuiteName();
  const dryRun = process.argv.includes('--dry-run');
  const configPath = path.resolve(
    repoRoot,
    process.env.EVAL_MATRIX_CONFIG ?? 'evals/providers.example.json',
  );
  const parsed = parseMatrixConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
  signal.throwIfAborted();
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ valid: true, suite, providers: parsed.providers }, null, 2)}\n`);
    return;
  }
  const results: MatrixResult[] = [];
  const matrixDirectory = path.join(reportsDir, 'matrix');
  await fs.mkdir(matrixDirectory, { recursive: true });
  for (const entry of parsed.providers) {
    signal.throwIfAborted();
    process.stdout.write(`\n=== ${entry.id}: ${entry.provider}/${entry.model} ===\n`);
    await fs.rm(path.join(reportsDir, 'latest.json'), { force: true });
    let exitCode = await runChild(entry, suite, signal);
    let summary: EvalRunSummary | undefined;
    let error: string | undefined;
    try {
      summary = JSON.parse(await fs.readFile(path.join(reportsDir, 'latest.json'), 'utf8')) as EvalRunSummary;
      await fs.writeFile(
        path.join(matrixDirectory, `${entry.id}.json`),
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    } catch (readError) {
      error = readError instanceof Error ? readError.message : String(readError);
      if (exitCode === 0) exitCode = 1;
    }
    results.push({ entry, exitCode, summary, error });
  }
  signal.throwIfAborted();
  await fs.writeFile(path.join(reportsDir, 'matrix-latest.json'), `${JSON.stringify({ suite, results }, null, 2)}\n`);
  await fs.writeFile(path.join(reportsDir, 'matrix-latest.md'), matrixMarkdown(results, suite));
  signal.throwIfAborted();
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new MatrixCancelledError('SIGINT'));
  const terminate = (): void => controller.abort(new MatrixCancelledError('SIGTERM'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  void main(controller.signal).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof MatrixCancelledError ? error.exitCode : 1;
  }).finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  });
}
