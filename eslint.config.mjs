import obsidianmd from 'eslint-plugin-obsidianmd'
import neostandard from 'neostandard'
import json from '@eslint/json'

const codeFiles = ['**/*.{js,jsx,ts,tsx,mjs,cjs}']

export default [
  {
    ignores: [
      'main.js',
      'node_modules/**',
      'esbuild.config.mjs',
      'version-bump.mjs',
      'eslint.config.mjs',
      /*
      Non-package.json JSON files: obsidianmd only sets `language: 'json/json'` on
      package.json and manifest.json (below) - others crash the JS parser. Skip them.
      */
      'data.json',
      'package-lock.json',
      'tsconfig.json',
      'versions.json',
      '.claude/**'
    ]
  },
  ...obsidianmd.configs.recommended,
  // Lint manifest.json with the obsidianmd manifest rules
  {
    files: ['manifest.json'],
    plugins: { json },
    language: 'json/json'
  },
  /*
  Neostandard's blocks have no `files:` filter, so its stylistic rules try to run
  on JSON files (which obsidianmd lints as JSON) and crash. Scope to JS/TS only.
  */
  ...neostandard({ ts: true, noJsx: true, semi: false }).map(c =>
    c.rules || c.plugins || c.languageOptions ? { ...c, files: c.files ?? codeFiles } : c
  ),
  /*
  obsidianmd's recommended preset re-applies typed rules globally via an outer
  config block, so they hit the JSON files (JSON parser crash). Disable for JSON.
  `no-irregular-whitespace` is in the same bucket.
  */
  {
    files: ['**/*.json'],
    rules: {
      'no-irregular-whitespace': 'off',
      'obsidianmd/no-plugin-as-component': 'off',
      'obsidianmd/no-view-references-in-plugin': 'off',
      'obsidianmd/no-unsupported-api': 'off',
      'obsidianmd/prefer-file-manager-trash-file': 'off',
      'obsidianmd/prefer-instanceof': 'off'
    }
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json', sourceType: 'module' }
    },
    rules: {
      'no-void': ['error', { allowAsStatement: true }],
      /*
      Match the scorecard's stricter defaults - don't add `caughtErrorsIgnorePattern: '^_'`,
      the scorecard flags unused `catch (_e)` regardless of the underscore convention.
      */
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
      // Obsidian APIs leak `any` everywhere; these would be all-noise:
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/restrict-plus-operands': 'off'
    }
  }
]
