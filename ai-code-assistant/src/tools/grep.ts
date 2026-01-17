/**
 * Grep Tool - Search file contents
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { glob as globAsync } from 'glob';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

interface GrepMatch {
  file: string;
  line: number;
  content: string;
}

export const GrepTool: Tool = {
  name: 'Grep',
  description: 'Search for a pattern in file contents. Returns matching lines with context.',

  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regular expression pattern to search for',
      },
      path: {
        type: 'string',
        description: 'Directory or file to search in (optional)',
      },
      glob_pattern: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "**/*.ts")',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case insensitive search (default: false)',
      },
    },
    required: ['pattern'],
  },

  requiresApproval: false, // Reading is safe

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const searchPattern = params.pattern as string;
    const searchPath = (params.path as string) || context.workingDirectory;
    const globPattern = (params.glob_pattern as string) || '**/*';
    const caseInsensitive = (params.case_insensitive as boolean) || false;

    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(searchPath)
        ? searchPath
        : path.join(context.workingDirectory, searchPath);

      // Check permissions
      if (!context.permissions.canRead(absolutePath)) {
        return {
          toolId: 'grep',
          success: false,
          error: `Permission denied: Cannot read ${absolutePath}`,
        };
      }

      // Create regex
      const flags = caseInsensitive ? 'gi' : 'g';
      let regex: RegExp;
      try {
        regex = new RegExp(searchPattern, flags);
      } catch {
        return {
          toolId: 'grep',
          success: false,
          error: `Invalid regex pattern: ${searchPattern}`,
        };
      }

      // Get files to search
      const files = await globAsync(globPattern, {
        cwd: absolutePath,
        absolute: true,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**', '**/*.min.js', '**/dist/**'],
      });

      // Search each file
      const matches: GrepMatch[] = [];
      const maxMatchesPerFile = 50;
      const maxTotalMatches = 200;

      for (const file of files) {
        if (matches.length >= maxTotalMatches) break;

        try {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');
          let fileMatches = 0;

          for (let i = 0; i < lines.length && fileMatches < maxMatchesPerFile; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: path.relative(context.workingDirectory, file),
                line: i + 1,
                content: lines[i].trim(),
              });
              fileMatches++;
            }
            regex.lastIndex = 0; // Reset regex state
          }
        } catch {
          // Skip files that can't be read (binary, permissions, etc.)
          continue;
        }
      }

      // Format output
      let output = '';
      if (matches.length === 0) {
        output = '(no matches found)';
      } else {
        output = matches
          .map(m => `${m.file}:${m.line}: ${m.content.slice(0, 200)}`)
          .join('\n');

        if (matches.length >= maxTotalMatches) {
          output += `\n\n... (results truncated, showing first ${maxTotalMatches} matches)`;
        }
      }

      return {
        toolId: 'grep',
        success: true,
        output,
        metadata: {
          pattern: searchPattern,
          searchPath: absolutePath,
          filesSearched: files.length,
          totalMatches: matches.length,
        },
      };
    } catch (error) {
      return {
        toolId: 'grep',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
