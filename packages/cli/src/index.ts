#!/usr/bin/env node

import process from 'node:process';

import { cliExitCode, renderCliError } from './errors';
import { main, PRIMARY_CLI_NAME } from './main';
import { installFetchDispatcher } from './providerRuntime';
import { installStdoutPipeGuard, STDOUT_CLOSED_EXIT_CODE, stdoutClosedByReader } from './stdout';

installStdoutPipeGuard();
// Before any request: every command, `mcp` included, starts here.
installFetchDispatcher();

main().catch((error: unknown) => {
  process.stderr.write(renderCliError(error, PRIMARY_CLI_NAME));
  if (process.env.OPEN_OCR_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = cliExitCode(error);
}).finally(() => {
  // The run was cancelled internally so it could clean up, but the caller
  // chose to stop reading: report that the way the CLI always has.
  if (stdoutClosedByReader()) process.exitCode = STDOUT_CLOSED_EXIT_CODE;
});
