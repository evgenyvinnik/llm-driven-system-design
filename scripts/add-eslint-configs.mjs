#!/usr/bin/env node

/**
 * Script to add ESLint flat config files to all frontend and backend projects
 * that are missing them.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Projects to skip (not real projects)
const skipDirs = ['node_modules', 'scripts', '20forms-20designs', 'mcplator', 'mdreader'];

// ESLint config for React/TypeScript frontends
const frontendConfig = `import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'src/routeTree.gen.ts'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
)
`;

// ESLint config for TypeScript backends
const backendTsConfig = `import js from '@eslint/js'
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
)
`;

// ESLint config for JavaScript backends
const backendJsConfig = `import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['dist', 'node_modules'] },
  {
    ...js.configs.recommended,
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
]
`;

// Get all project directories
const projectDirs = fs.readdirSync(rootDir)
  .filter(dir => {
    const fullPath = path.join(rootDir, dir);
    return fs.statSync(fullPath).isDirectory() && !skipDirs.includes(dir);
  });

let frontendConfigs = 0;
let backendConfigs = 0;

for (const project of projectDirs) {
  const frontendDir = path.join(rootDir, project, 'frontend');
  const backendDir = path.join(rootDir, project, 'backend');

  // Add frontend config if missing
  if (fs.existsSync(path.join(frontendDir, 'package.json'))) {
    if (!hasEslintConfig(frontendDir)) {
      fs.writeFileSync(path.join(frontendDir, 'eslint.config.js'), frontendConfig);
      console.log(`Created frontend config: ${project}`);
      frontendConfigs++;
    }
  }

  // Add backend config if missing
  if (fs.existsSync(path.join(backendDir, 'package.json'))) {
    if (!hasEslintConfig(backendDir)) {
      const pkgPath = path.join(backendDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const isTypeScript = pkg.devDependencies?.typescript || pkg.dependencies?.typescript;

      const config = isTypeScript ? backendTsConfig : backendJsConfig;
      fs.writeFileSync(path.join(backendDir, 'eslint.config.js'), config);
      console.log(`Created backend config: ${project} (${isTypeScript ? 'TypeScript' : 'JavaScript'})`);
      backendConfigs++;
    }
  }
}

console.log(`\nSummary:`);
console.log(`  Frontend configs created: ${frontendConfigs}`);
console.log(`  Backend configs created: ${backendConfigs}`);

function hasEslintConfig(dir) {
  const configFiles = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.json',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    '.eslintrc'
  ];

  return configFiles.some(file => fs.existsSync(path.join(dir, file)));
}
