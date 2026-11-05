import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-namespace': 'off', // Allow namespace for Express type augmentation
      '@typescript-eslint/no-require-imports': 'off', // Allow require for dynamic imports
      'no-case-declarations': 'off', // Allow declarations in case blocks
      'no-constant-condition': 'off', // Allow while(true) for worker loops
      'no-control-regex': 'off', // Allow control characters in regex
      'prefer-const': 'warn', // Only warn for let that should be const
      'no-useless-escape': 'warn', // Only warn for unnecessary escapes
    },
  },
)
