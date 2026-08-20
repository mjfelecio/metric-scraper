import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'output/**', 'coverage/**', 'node_modules/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Config files that are plain JS are not part of the TS program.
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  {
    // The web client runs in the browser, not in Node.
    files: ['src/web/**/*.ts'],
    ignores: ['src/web/server/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // R9: the repo-wide `fixStyle: 'inline-type-imports'` above autofixes a
    // type-only import to `import { type X } from '...'`. Under
    // `verbatimModuleSyntax` that per-specifier form is not guaranteed to be
    // fully erased — TypeScript can still emit a bare, side-effecting
    // `import '...'` for it — whereas a whole-clause `import type { X }` is
    // always erased completely. That distinction is silent everywhere except
    // here: these are the files a Node-only module (e.g.
    // `bandwidth-baselines.ts`'s `node:fs`/`node:path` imports, reached via
    // `RunSummary`/`BaselineSummary`) could leak into the browser bundle
    // through, and only `vite build` — never `tsc`, which this repo has no CI
    // step for — catches it. Autofix must never regenerate the broken form
    // here, so it always writes the whole-clause style instead.
    files: ['src/web/**/*.ts', 'src/app/types.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
  prettier,
);
