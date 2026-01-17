/**
 * Glob Tool - Find files by pattern
 */

import { glob as globAsync } from 'glob';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

export const GlobTool: Tool = {
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns list of matching file paths.',

  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.js")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in (optional, defaults to working directory)',
      },
    },
    required: ['pattern'],
  },

  requiresApproval: false, // Reading directory structure is safe

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) || context.workingDirectory;

    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(searchPath)
        ? searchPath
        : path.join(context.workingDirectory, searchPath);

      // Check permissions
      if (!context.permissions.canRead(absolutePath)) {
        return {
          toolId: 'glob',
          success: false,
          error: `Permission denied: Cannot read ${absolutePath}`,
        };
      }

      // Execute glob
      const files = await globAsync(pattern, {
        cwd: absolutePath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      // Sort by path
      files.sort();

      // Truncate if too many files
      const maxFiles = 500;
      let output: string;
      if (files.length > maxFiles) {
        output = files.slice(0, maxFiles).join('\n') +
          `\n\n... and ${files.length - maxFiles} more files`;
      } else {
        output = files.join('\n');
      }

      return {
        toolId: 'glob',
        success: true,
        output: output || '(no matching files)',
        metadata: {
          pattern,
          searchPath: absolutePath,
          totalMatches: files.length,
        },
      };
    } catch (error) {
      return {
        toolId: 'glob',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
