import { once } from 'node:events';
import process from 'node:process';

import { isBrokenPipeError } from './errors';

/**
 * stdout as a pipe its reader may close early (`| head`, a killed agent).
 *
 * Writable streams report EPIPE asynchronously, so it never rejects the write
 * that caused it. A running batch subscribes through {@link onStdoutClosed} and
 * is cancelled like a SIGPIPE, so it still releases its output lock and writes
 * its summary; exiting on the spot used to leave both behind and block the next
 * run. With no subscriber there is nothing to clean up and the process exits
 * at once. The exit status stays {@link STDOUT_CLOSED_EXIT_CODE}, as it always
 * was: a reader that stops listening is the reader's choice, not a failure.
 */
let closed = false;
const closeListeners = new Set<() => void>();

export const STDOUT_CLOSED_EXIT_CODE = 0;

export function installStdoutPipeGuard(): void {
  process.stdout.on('error', (error: Error) => {
    // Scoped to stdout itself so an unrelated provider or filesystem EPIPE
    // still reaches the ordinary typed-error path.
    if (!isBrokenPipeError(error)) throw error;
    if (closed) return;
    closed = true;
    if (closeListeners.size === 0) process.exit(STDOUT_CLOSED_EXIT_CODE);
    for (const listener of closeListeners) listener();
  });
}

/** Whether stdout's reader went away during this process. */
export function stdoutClosedByReader(): boolean {
  return closed;
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
