// Only the check bun lint's no-unused-vars misses (a variable updated only
// through compound assignment, `x += 1`, is reported as used). No type
// information, so it stays fast; everything else is linted by `bun lint`.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', '**/dist/**', 'coverage', '**/coverage/**', 'node_modules', '.claude/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
