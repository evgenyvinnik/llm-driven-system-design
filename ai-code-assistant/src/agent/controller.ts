/**
 * Agent Controller - Core orchestration loop for the AI coding assistant.
 *
 * This is the heart of the evylcode system - the agentic loop that coordinates
 * between the user, LLM, and tools. It implements the following cycle:
 *
 * 1. Receive user input
 * 2. Send context to LLM
 * 3. Parse LLM response for tool calls
 * 4. Execute tools with permission checks
 * 5. Feed tool results back to LLM
 * 6. Repeat until LLM returns without tool calls
 *
 * The controller handles error recovery, permission management, and
 * conversation state throughout this process.
 *
 * @module agent/controller
 */

import type {
  Message,
  ToolCall,
  ToolResult,
  ToolContext,
  LLMProvider,
  AgentState,
  PermissionRequest,
} from '../types/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { SessionManager } from '../session/manager.js';
import type { CLIInterface } from '../cli/interface.js';

/**
 * System prompt that instructs the LLM on its role and available tools.
 * This is prepended to every conversation context.
 */
const SYSTEM_PROMPT = `You are an AI coding assistant that helps developers write, debug, and understand code.

You have access to the following tools:
- Read: Read file contents
- Write: Create new files
- Edit: Modify existing files using string replacement
- Bash: Execute shell commands
- Glob: Find files by pattern
- Grep: Search file contents

Guidelines:
- Always read files before attempting to edit them
- For Edit, the old_string must be unique in the file
- Be careful with destructive operations
- Explain what you're doing and why
- Ask for clarification if the request is ambiguous

When using tools:
- Use absolute paths when possible
- For large files, read only the relevant portions
- Combine multiple reads into a single response when appropriate
`;

/**
 * Orchestrates the interaction between user, LLM, and tools.
 *
 * The AgentController manages:
 * - The agentic loop (user -> LLM -> tools -> LLM -> ...)
 * - Conversation state and message history
 * - Tool execution with permission checks
 * - Session persistence
 * - Error handling and recovery
 */
export class AgentController {
  /** LLM provider for generating responses */
  private llm: LLMProvider;
  /** Registry of available tools */
  private tools: ToolRegistry;
  /** Permission manager for access control */
  private permissions: PermissionManager;
  /** Session manager for persistence */
  private session: SessionManager;
  /** CLI interface for user interaction */
  private cli: CLIInterface;
  /** Current working directory */
  private workingDirectory: string;
  /** Current agent state */
  private state: AgentState;

  /**
   * Creates a new AgentController.
   * @param llm - LLM provider for generating responses
   * @param tools - Tool registry with available tools
   * @param permissions - Permission manager for access control
   * @param session - Session manager for persistence
   * @param cli - CLI interface for user interaction
   * @param workingDirectory - Current working directory
   */
  constructor(
    llm: LLMProvider,
    tools: ToolRegistry,
    permissions: PermissionManager,
    session: SessionManager,
    cli: CLIInterface,
    workingDirectory: string
  ) {
    this.llm = llm;
    this.tools = tools;
    this.permissions = permissions;
    this.session = session;
    this.cli = cli;
    this.workingDirectory = workingDirectory;

    this.state = {
      conversationId: '',
      messages: [],
      toolCalls: [],
      pendingApprovals: [],
      isRunning: false,
    };
  }

  /**
   * Run the agentic loop for a user input.
   * This is the main entry point for processing user requests.
   * @param userInput - The user's natural language request
   */
  async run(userInput: string): Promise<void> {
    if (this.state.isRunning) {
      this.cli.printError('Agent is already processing a request');
      return;
    }

    this.state.isRunning = true;

    try {
      // Add user message to context
      const userMessage: Message = {
        role: 'user',
        content: userInput,
        timestamp: new Date(),
      };
      this.state.messages.push(userMessage);
      this.session.addMessage(userMessage);

      // Start the agentic loop
      await this.executeLoop();

      // Save session after successful completion
      await this.session.saveCurrent();
    } catch (error) {
      this.cli.printError(error instanceof Error ? error.message : String(error));
    } finally {
      this.state.isRunning = false;
    }
  }

  /**
   * Execute the main agentic loop.
   * Iterates between LLM calls and tool execution until complete.
   * Includes a safety limit to prevent infinite loops.
   */
  private async executeLoop(): Promise<void> {
    let iteration = 0;
    const maxIterations = 10; // Safety limit

    while (iteration < maxIterations) {
      iteration++;

      // Show spinner while waiting for LLM
      this.cli.startSpinner('Thinking...');

      try {
        // Get LLM response
        const response = await this.llm.complete({
          messages: this.getContextMessages(),
          tools: this.tools.getDefinitions(),
        });

        this.cli.stopSpinner(true);

        // Stream text output
        if (response.content) {
          this.cli.printAssistant(response.content);

          // Add assistant message to context
          const assistantMessage: Message = {
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
            timestamp: new Date(),
          };
          this.state.messages.push(assistantMessage);
          this.session.addMessage(assistantMessage);
        }

        // Check for tool calls
        if (response.toolCalls.length === 0) {
          break; // No more tools to execute, we're done
        }

        // Execute tools
        const results = await this.executeTools(response.toolCalls);

        // Add tool results to context
        const toolMessage: Message = {
          role: 'tool',
          content: results.map(r => r.output || r.error || '').join('\n'),
          toolResults: results,
          timestamp: new Date(),
        };
        this.state.messages.push(toolMessage);
        this.session.addMessage(toolMessage);

        // Continue the loop to get LLM's response to tool results
      } catch (error) {
        this.cli.stopSpinner(false);
        throw error;
      }
    }

    if (iteration >= maxIterations) {
      this.cli.printError('Maximum iterations reached. Stopping to prevent infinite loop.');
    }
  }

  /**
   * Execute tool calls, handling permissions for each.
   * Auto-approved tools run in parallel, approval-required tools run sequentially.
   * @param calls - Array of tool calls from the LLM
   * @returns Array of tool execution results
   */
  private async executeTools(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    // Separate auto-approved and needs-approval tools
    const autoApproved: ToolCall[] = [];
    const needsApproval: ToolCall[] = [];

    for (const call of calls) {
      if (this.tools.requiresApproval(call.name, call.parameters)) {
        needsApproval.push(call);
      } else {
        autoApproved.push(call);
      }
    }

    // Execute auto-approved tools in parallel
    if (autoApproved.length > 0) {
      const context = this.createToolContext();
      const autoResults = await Promise.all(
        autoApproved.map(call => this.executeToolWithDisplay(call, context))
      );
      results.push(...autoResults);
    }

    // Execute tools that need approval sequentially
    for (const call of needsApproval) {
      const request: PermissionRequest = {
        tool: call.name,
        operation: this.describeToolOperation(call),
        details: this.getToolDetails(call),
      };

      const approved = await this.permissions.requestPermission(request);

      if (approved) {
        const context = this.createToolContext();
        const result = await this.executeToolWithDisplay(call, context);
        results.push(result);
      } else {
        results.push({
          toolId: call.id,
          success: false,
          error: 'User denied permission',
        });
        this.cli.printInfo('Permission denied - skipping operation');
      }
    }

    return results;
  }

  /**
   * Execute a single tool with CLI display.
   * Shows the tool call and its result to the user.
   * @param call - The tool call to execute
   * @param context - Execution context with permissions
   * @returns The tool execution result
   */
  private async executeToolWithDisplay(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    this.cli.printToolCall(call.name, call.parameters);

    const result = await this.tools.execute(call.name, call.parameters, context);
    result.toolId = call.id;

    this.cli.printToolResult(result.success, result.output, result.error);

    return result;
  }

  /**
   * Create a tool execution context.
   * @returns Context with working directory and permissions
   */
  private createToolContext(): ToolContext {
    return {
      workingDirectory: this.workingDirectory,
      permissions: this.permissions,
    };
  }

  /**
   * Get messages formatted for LLM context.
   * Prepends the system prompt to the conversation.
   * @returns Array of messages including system prompt
   */
  private getContextMessages(): Message[] {
    const systemMessage: Message = {
      role: 'system',
      content: SYSTEM_PROMPT,
      timestamp: new Date(),
    };

    return [systemMessage, ...this.state.messages];
  }

  /**
   * Generate a human-readable description of a tool operation.
   * Used for permission request display.
   * @param call - The tool call to describe
   * @returns Description of the operation
   */
  private describeToolOperation(call: ToolCall): string {
    switch (call.name) {
      case 'Write':
        return 'Write new file';
      case 'Edit':
        return 'Edit file content';
      case 'Bash':
        return `Execute command: ${call.parameters.command}`;
      default:
        return `Execute ${call.name}`;
    }
  }

  /**
   * Get details about a tool call for permission display.
   * Returns the target file path or command.
   * @param call - The tool call
   * @returns Details string (file path or command)
   */
  private getToolDetails(call: ToolCall): string {
    switch (call.name) {
      case 'Write':
      case 'Edit':
      case 'Read':
        return call.parameters.file_path as string || 'unknown file';
      case 'Bash':
        return call.parameters.command as string || 'unknown command';
      default:
        return JSON.stringify(call.parameters);
    }
  }

  /**
   * Clear the conversation history.
   * Used for /clear command.
   */
  clearHistory(): void {
    this.state.messages = [];
    this.session.clearMessages();
  }

  /**
   * Get a copy of the current agent state.
   * @returns Clone of the current state
   */
  getState(): AgentState {
    return { ...this.state };
  }
}
