import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

interface CliPackageManifest {
  dependencies?: Record<string, string>;
  openOcrBuild?: {
    bundledDependencies?: string[];
  };
}

const cliPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as CliPackageManifest;

// The publishable package is the source of truth for runtime dependencies and
// for the small, explicit bundle allowlist. The Gemini SDK is bundled so npm
// consumers do not need to approve its no-op preinstall or protobufjs's
// postinstall; native and optional runtime dependencies remain external.
const bundledDependencies = new Set(cliPackage.openOcrBuild?.bundledDependencies ?? []);
const external = Object.keys(cliPackage.dependencies ?? {})
  .filter((packageName) => !bundledDependencies.has(packageName))
  .sort();

export default defineConfig({
  entry: ['src/index.ts'],
  tsconfig: 'tsconfig.json',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  external,
  esbuildOptions(options) {
    // The CLI authenticates with an API key and never uses Vertex ADC. Using
    // the SDK's fetch-based web entry avoids bundling google-auth-library's
    // CommonJS-only dynamic requires into the ESM executable.
    options.alias = {
      ...options.alias,
      '@google/genai': '@google/genai/web',
    };
  },
});
