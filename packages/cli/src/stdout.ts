import { once } from 'node:events';
import process from 'node:process';

import { isBrokenPipeError } from './errors';

/**
 * stdout as a pipe its reader may close early (`| head`, a killed agent).
 *
 * Writable streams report EPIPE asynchronously, so it never rejects the write
 * that caused it. A running batch subscribes through {@link onStdoutClosed} and
 * is cancelled like a SIGPIPE: it still releases its output lock and writes its
 * summary, then exits 141. With no subscriber there is nothing to clean up and
 * the process exits 141 at once. Either way the truncation is visible to
 * `set -o pipefail` instead of passing for success.
 */
let closed = false;
const closeListeners = new Set<() => void>();

export const STDOUT_CLOSED_EXIT_CODE = 141;

export function installStdoutPipeGuard(): void {
  process.stdout.on('error', (error: Error) => {
    // Scoped to stdout itself so an unrelated provider or filesystem EPIPE
    // still reaches the ordinary typed-error path.
    if (!isBrokenPipeError(error)) throw error;
    if (closed) return;
    closed = true;
    process.exitCode = STDOUT_CLOSED_EXIT_CODE;
    if (closeListeners.size === 0) process.exit(STDOUT_CLOSED_EXIT_CODE);
    for (const listener of closeListeners) listener();
  });
}

/** Subscribe to stdout closing; returns the unsubscribe function. */
export function onStdoutClosed(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

/**
 * Write to stdout with backpressure. Once the reader is gone every write is a
 * no-op: waiting for a `drain` that can never come would hang the cleanup the
 * close is supposed to trigger.
 */
export async function writeStdout(text: string): Promise<void> {
  if (closed || process.stdout.destroyed) return;
  if (process.stdout.write(text)) return;
  try {
    await once(process.stdout, 'drain');
  } catch (error) {
    if (!isBrokenPipeError(error)) throw error;
  }
}
