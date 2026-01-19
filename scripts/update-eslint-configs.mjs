#!/usr/bin/env node

/**
 * Script to update ESLint configs with more lenient rules for common patterns
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(__dirname);

// Updated backend ESLint config with more lenient rules
const backendConfigTS = `import js from '@eslint/js'
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
`;

const backendConfigJS = `import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.js'],
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
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-case-declarations': 'off',
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'prefer-const': 'warn',
      'no-useless-escape': 'warn',
    },
  },
)
`;

// Get all backend directories
const entries = fs.readdirSync(ROOT_DIR, { withFileTypes: true });
let updatedCount = 0;

for (const entry of entries) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'scripts') {
    continue;
  }

  const backendPath = path.join(ROOT_DIR, entry.name, 'backend');
  const configPath = path.join(backendPath, 'eslint.config.js');

  if (fs.existsSync(configPath)) {
    // Check if this is a TypeScript or JavaScript project
    const packageJsonPath = path.join(backendPath, 'package.json');
    let isTS = true;

    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      // Check if it's a JS project (no typescript in dependencies)
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      isTS = 'typescript' in deps || 'tsx' in deps;
    }

    const config = isTS ? backendConfigTS : backendConfigJS;
    fs.writeFileSync(configPath, config, 'utf8');
    updatedCount++;
    console.log(`Updated: ${entry.name}/backend`);
  }
}

console.log(`\nTotal ESLint configs updated: ${updatedCount}`);
