/**
 * Write Tool - Create new files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

export const WriteTool: Tool = {
  name: 'Write',
  description: 'Write content to a new file. Will overwrite if file exists.',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to write',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file',
      },
    },
    required: ['file_path', 'content'],
  },

  requiresApproval: true, // Writing requires approval

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const content = params.content as string;

    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(context.workingDirectory, filePath);

      // Check permissions
      if (!context.permissions.canWrite(absolutePath)) {
        return {
          toolId: 'write',
          success: false,
          error: `Permission denied: Cannot write to ${absolutePath}`,
        };
      }

      // Ensure directory exists
      const dir = path.dirname(absolutePath);
      await fs.mkdir(dir, { recursive: true });

      // Write file
      await fs.writeFile(absolutePath, content, 'utf-8');

      // Count lines
      const lineCount = content.split('\n').length;

      return {
        toolId: 'write',
        success: true,
        output: `File created successfully: ${absolutePath} (${lineCount} lines)`,
        metadata: {
          file: absolutePath,
          lineCount,
          size: Buffer.byteLength(content, 'utf-8'),
        },
      };
    } catch (error) {
      return {
        toolId: 'write',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
