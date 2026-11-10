import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

/**
 * Division of labour with the compiler: the `strict` switches own types and dead code, ESLint owns
 * the layer the compiler does not cover (hooks, promises, import order). The parameters are per
 * repository and need not match across them.
 */
export default [
  { ignores: ['lib/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The browser half; see tsconfig.client.json.
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      // A leading `_` marks a binding that is deliberately unused (a callback placeholder, or a key
      // dropped by destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  eslintConfigPrettier,
]
