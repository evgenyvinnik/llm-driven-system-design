/**
 * Read Tool - Read file contents.
 *
 * This tool allows the AI assistant to read file contents from the filesystem.
 * It's a core capability for code understanding, debugging, and modification workflows.
 * Files are returned with line numbers for easy reference in subsequent edit operations.
 *
 * @module tools/read
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

/**
 * ReadTool implementation for reading file contents.
 *
 * Features:
 * - Reads files with 1-indexed line numbers for easy reference
 * - Supports offset and limit for reading large files in chunks
 * - Resolves relative paths against the working directory
 * - Checks read permissions before accessing files
 *
 * This tool does not require user approval as reading is considered safe.
 */
export const ReadTool: Tool = {
  name: 'Read',
  description: 'Read contents of a file. Returns file content with line numbers.',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Starting line number (1-indexed, optional)',
      },
      limit: {
        type: 'number',
        description: 'Number of lines to read (optional)',
      },
    },
    required: ['file_path'],
  },

  requiresApproval: false, // Reading is safe

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const offset = (params.offset as number) || 0;
    const limit = params.limit as number | undefined;

    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(context.workingDirectory, filePath);

      // Check permissions
      if (!context.permissions.canRead(absolutePath)) {
        return {
          toolId: 'read',
          success: false,
          error: `Permission denied: Cannot read ${absolutePath}`,
        };
      }

      // Check if file exists
      try {
        await fs.access(absolutePath);
      } catch {
        return {
          toolId: 'read',
          success: false,
          error: `File not found: ${absolutePath}`,
        };
      }

      // Read file
      const content = await fs.readFile(absolutePath, 'utf-8');
      const lines = content.split('\n');

      // Apply offset and limit
      const startLine = Math.max(0, offset);
      const selectedLines = limit
        ? lines.slice(startLine, startLine + limit)
        : lines.slice(startLine);

      // Format with line numbers (1-indexed)
      const output = selectedLines
        .map((line, i) => `${String(startLine + i + 1).padStart(6, ' ')}\t${line}`)
        .join('\n');

      return {
        toolId: 'read',
        success: true,
        output,
        metadata: {
          file: absolutePath,
          totalLines: lines.length,
          linesReturned: selectedLines.length,
        },
      };
    } catch (error) {
      return {
        toolId: 'read',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
