/**
 * Bash Tool - Execute shell commands.
 *
 * This tool enables the AI assistant to run shell commands for tasks like
 * running tests, building projects, installing dependencies, and querying
 * the development environment. It includes safety features to prevent
 * dangerous operations while allowing common development tasks.
 *
 * @module tools/bash
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext, ToolResult } from '../types/index.js';

/** Promisified exec for async/await usage */
const execAsync = promisify(exec);

/**
 * Patterns for commands that are auto-approved without user confirmation.
 * These are read-only or common development commands that don't modify state.
 */
const SAFE_PATTERNS = [
  /^ls\b/,
  /^pwd$/,
  /^echo\b/,
  /^cat\s+[^\|;&]+$/,  // cat without pipes or command chaining
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^git\s+(status|log|diff|branch|remote|show)/,
  /^npm\s+(run\s+)?(dev|build|test|lint|start)/,
  /^node\s+--version/,
  /^npm\s+--version/,
  /^which\b/,
  /^type\b/,
  /^file\b/,
];

/**
 * Patterns for commands that are always blocked for safety.
 * These commands can cause system damage and should never be executed.
 */
const BLOCKED_PATTERNS = [
  /rm\s+-rf?\s+[\/~]/,  // Recursive delete from root or home
  />\s*\/dev\/sd/,       // Write to block devices
  /mkfs/,                // Format filesystems
  /dd\s+if=/,            // Direct disk access
  /:(){:|:&};:/,         // Fork bomb
  /sudo/,                // Privilege escalation
  /chmod\s+777/,         // Insecure permissions
];

/**
 * BashTool implementation for executing shell commands.
 *
 * Features:
 * - Executes commands with configurable timeout (default: 2 minutes)
 * - Auto-approves safe commands (ls, git status, npm run, etc.)
 * - Blocks dangerous commands (rm -rf /, sudo, fork bombs, etc.)
 * - Captures both stdout and stderr
 * - Truncates very large output to prevent memory issues
 *
 * Approval is dynamic: safe patterns are auto-approved, while other
 * commands require user confirmation.
 */
export const BashTool: Tool = {
  name: 'Bash',
  description: 'Execute a shell command. Safe commands (ls, git status, npm run) are auto-approved.',

  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for the command (optional)',
      },
    },
    required: ['command'],
  },

  requiresApproval: (params: Record<string, unknown>): boolean => {
    const command = params.command as string;
    // Auto-approve safe commands
    return !SAFE_PATTERNS.some(p => p.test(command));
  },

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) || 120000;
    const workingDirectory = (params.working_directory as string) || context.workingDirectory;

    try {
      // Check for blocked patterns
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          return {
            toolId: 'bash',
            success: false,
            error: `Command blocked for safety: This command pattern is not allowed.`,
          };
        }
      }

      // Check execution permission
      if (!context.permissions.canExecute(command)) {
        return {
          toolId: 'bash',
          success: false,
          error: `Permission denied: Cannot execute "${command}"`,
        };
      }

      // Execute command
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDirectory,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      // Combine output
      let output = stdout;
      if (stderr) {
        output += stderr ? `\n[stderr]\n${stderr}` : '';
      }

      // Truncate if too long
      const maxLength = 50000;
      if (output.length > maxLength) {
        output = output.slice(0, maxLength / 2) +
          '\n\n... [output truncated] ...\n\n' +
          output.slice(-maxLength / 2);
      }

      return {
        toolId: 'bash',
        success: true,
        output: output || '(no output)',
        metadata: {
          command,
          workingDirectory,
        },
      };
    } catch (error) {
      const err = error as Error & { code?: number; stderr?: string };

      return {
        toolId: 'bash',
        success: false,
        error: err.message,
        metadata: {
          command,
          exitCode: err.code,
          stderr: err.stderr,
        },
      };
    }
  },
};
