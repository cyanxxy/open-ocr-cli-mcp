#!/usr/bin/env node

import process from 'node:process';

import { cliExitCode, renderCliError } from './errors';
import { main, PRIMARY_CLI_NAME } from './main';
import { installStdoutPipeGuard } from './stdout';

installStdoutPipeGuard();

main().catch((error: unknown) => {
  process.stderr.write(renderCliError(error, PRIMARY_CLI_NAME));
  if (process.env.OPEN_OCR_DEBUG === '1' && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = cliExitCode(error);
});
