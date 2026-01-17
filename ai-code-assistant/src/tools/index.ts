/**
 * Tool Registry - Central tool management
 */

import type { Tool, ToolDefinition, ToolContext, ToolResult } from '../types/index.js';
import { ReadTool } from './read.js';
import { WriteTool } from './write.js';
import { EditTool } from './edit.js';
import { BashTool } from './bash.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor() {
    // Register default tools
    this.register(ReadTool);
    this.register(WriteTool);
    this.register(EditTool);
    this.register(BashTool);
    this.register(GlobTool);
    this.register(GrepTool);
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all tools
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tool definitions for LLM
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /**
   * Check if a tool requires approval for given params
   */
  requiresApproval(name: string, params: Record<string, unknown>): boolean {
    const tool = this.get(name);
    if (!tool) return true; // Unknown tools require approval

    if (typeof tool.requiresApproval === 'function') {
      return tool.requiresApproval(params);
    }
    return tool.requiresApproval;
  }

  /**
   * Execute a tool
   */
  async execute(name: string, params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(name);

    if (!tool) {
      return {
        toolId: name,
        success: false,
        error: `Unknown tool: ${name}`,
      };
    }

    try {
      return await tool.execute(params, context);
    } catch (error) {
      return {
        toolId: name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// Export tools
export { ReadTool } from './read.js';
export { WriteTool } from './write.js';
export { EditTool } from './edit.js';
export { BashTool } from './bash.js';
export { GlobTool } from './glob.js';
export { GrepTool } from './grep.js';
