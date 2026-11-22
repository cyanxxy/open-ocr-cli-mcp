import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { userHomeDirectory } from './config';

describe('userHomeDirectory', () => {
  it('reads the home directory from the environment on every call', () => {
    const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const first = path.join(path.sep, 'first-home');
    const second = path.join(path.sep, 'second-home');
    expect(userHomeDirectory({ [variable]: first })).toBe(first);
    expect(userHomeDirectory({ [variable]: second })).toBe(second);
  });

  it('falls back to the account directory when the variable is unset or empty', () => {
    const variable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    expect(userHomeDirectory({})).toBeTruthy();
    expect(userHomeDirectory({ [variable]: '' })).toBe(userHomeDirectory({}));
  });
});
