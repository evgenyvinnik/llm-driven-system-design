/**
 * Edit Tool - Modify existing files using string replacement
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

export const EditTool: Tool = {
  name: 'Edit',
  description: 'Edit an existing file by replacing a string. The old_string must be unique in the file unless replace_all is true.',

  parameters: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the file to edit',
      },
      old_string: {
        type: 'string',
        description: 'The exact string to replace (must be unique in file)',
      },
      new_string: {
        type: 'string',
        description: 'The string to replace it with',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default: false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  requiresApproval: true, // Writing requires approval

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const oldString = params.old_string as string;
    const newString = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) || false;

    try {
      // Resolve to absolute path
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(context.workingDirectory, filePath);

      // Check permissions
      if (!context.permissions.canWrite(absolutePath)) {
        return {
          toolId: 'edit',
          success: false,
          error: `Permission denied: Cannot write to ${absolutePath}`,
        };
      }

      // Check if file exists
      try {
        await fs.access(absolutePath);
      } catch {
        return {
          toolId: 'edit',
          success: false,
          error: `File not found: ${absolutePath}`,
        };
      }

      // Read file
      const content = await fs.readFile(absolutePath, 'utf-8');

      // Check for occurrences
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) {
        return {
          toolId: 'edit',
          success: false,
          error: `String not found in file: "${oldString.slice(0, 50)}${oldString.length > 50 ? '...' : ''}"`,
        };
      }

      if (occurrences > 1 && !replaceAll) {
        return {
          toolId: 'edit',
          success: false,
          error: `String appears ${occurrences} times in the file. Either provide more context to make it unique, or set replace_all=true.`,
        };
      }

      // Perform replacement
      const newContent = replaceAll
        ? content.replaceAll(oldString, newString)
        : content.replace(oldString, newString);

      // Write file
      await fs.writeFile(absolutePath, newContent, 'utf-8');

      return {
        toolId: 'edit',
        success: true,
        output: `File updated successfully: ${absolutePath} (${replaceAll ? occurrences : 1} replacement${replaceAll && occurrences > 1 ? 's' : ''})`,
        metadata: {
          file: absolutePath,
          replacements: replaceAll ? occurrences : 1,
        },
      };
    } catch (error) {
      return {
        toolId: 'edit',
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
