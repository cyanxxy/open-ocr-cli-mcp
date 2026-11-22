import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  { ignores: ['dist', '**/dist/**', 'coverage', '**/coverage/**', 'node_modules', '.claude/**', '*.config.js'] },

  // Base configuration for all JS/TS files. Everything in this repo runs in
  // Node (the OCR engine in packages/engine, the CLI in packages/cli, the evals
  // harness),
  // so `globals.node` is the baseline. Type-aware linting is enabled via
  // `projectService` + `recommendedTypeChecked` (audit M-08). Newly-surfaced
  // type-checked rules are set to 'warn' below as a ratchet so lint stays green
  // while the noise is paid down incrementally.
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // audit M-08 ratchet: type-aware rules that are noisy on the current
      // codebase are downgraded to 'warn' so CI lint stays green. Promote to
      // 'error' as each is paid down.
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-redundant-type-constituents': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/unbound-method': 'warn',
      '@typescript-eslint/await-thenable': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
    },
  },

  // Config / tooling files and the Node-side eval scripts are not part of the
  // app tsconfig project graph; lint them without type information to avoid
  // "file not found by the project service" parsing errors (audit M-08).
  {
    files: ['**/*.config.{js,ts}', 'evals/**/*.ts', 'scripts/**/*.{js,mjs,cjs,ts}', '.github/**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Test files configuration - strict type safety enforced
  {
    files: ['**/*.{test,spec}.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: {
        ...globals.vitest,
        ...globals.node,
      },
    },
    rules: {
      // Enforce strict type safety in tests - this is a production project
      '@typescript-eslint/no-explicit-any': 'error',
    },
  }
);
