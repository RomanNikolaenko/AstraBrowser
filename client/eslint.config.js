// @ts-check
// ESLint: TypeScript і шаблони Angular. Перевірка — `npm run lint`, автовиправлення — `npm run lint:fix`.
const path = require('node:path');
const { includeIgnoreFile } = require('@eslint/compat');
const eslint = require('@eslint/js');
const { defineConfig } = require('eslint/config');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = defineConfig([
  // Що не перевіряти — у .eslintignore (сам ESLint 9+ цей файл уже не читає).
  includeIgnoreFile(path.resolve(__dirname, '.eslintignore'), 'Ignored by .eslintignore'),
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'app',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'app',
          style: 'kebab-case',
        },
      ],
    },
  },
  {
    // Підробки в тестах (сервіси, ResizeObserver) навмисно нічого не роблять.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
    rules: {},
  },
]);
