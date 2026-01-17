/**
 * Core type definitions for the AI Code Assistant.
 *
 * This module defines the fundamental interfaces and types used throughout
 * the evylcode CLI application, including message types for the conversation
 * system, tool execution interfaces, permission management, LLM provider
 * abstractions, and session management types.
 *
 * @module types
 */

/**
 * Represents the role of a message participant in the conversation.
 * - 'user': Input from the human user
 * - 'assistant': Response from the AI assistant (Claude)
 * - 'tool': Result from tool execution
 * - 'system': System-level instructions or context
 */
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

/**
 * Represents a single message in the conversation history.
 * Messages form the context sent to the LLM for generating responses.
 */
export interface Message {
  /** The role of the message sender */
  role: MessageRole;
  /** The text content of the message */
  content: string;
  /** Tool calls requested by the assistant (only for assistant messages) */
  toolCalls?: ToolCall[];
  /** Results from tool execution (only for tool messages) */
  toolResults?: ToolResult[];
  /** Timestamp when the message was created */
  timestamp: Date;
}

/**
 * Represents a request from the LLM to execute a specific tool.
 * The agent controller uses this to invoke the appropriate tool handler.
 */
export interface ToolCall {
  /** Unique identifier for this tool call (used to match results) */
  id: string;
  /** Name of the tool to execute (e.g., 'Read', 'Write', 'Bash') */
  name: string;
  /** Parameters to pass to the tool */
  parameters: Record<string, unknown>;
}

/**
 * Represents the result of a tool execution.
 * Returned to the LLM so it can incorporate the result into its response.
 */
export interface ToolResult {
  /** ID of the tool call this result corresponds to */
  toolId: string;
  /** Whether the tool execution succeeded */
  success: boolean;
  /** Output from successful execution */
  output?: string;
  /** Error message if execution failed */
  error?: string;
  /** Additional metadata about the execution */
  metadata?: Record<string, unknown>;
}

/**
 * Context provided to tools during execution.
 * Contains environment information and permission checks.
 */
export interface ToolContext {
  /** Current working directory for relative path resolution */
  workingDirectory: string;
  /** Permission set for checking read/write/execute access */
  permissions: PermissionSet;
  /** Optional abort signal for cancelling long-running operations */
  abortSignal?: AbortSignal;
}

/**
 * Defines a tool's metadata for the LLM.
 * Used to inform the LLM about available tools and their parameters.
 */
export interface ToolDefinition {
  /** Tool name as referenced by the LLM */
  name: string;
  /** Human-readable description of what the tool does */
  description: string;
  /** JSON Schema defining the tool's parameters */
  parameters: JSONSchema;
}

/**
 * Full tool implementation interface.
 * Combines metadata with execution logic and approval requirements.
 */
export interface Tool {
  /** Tool name */
  name: string;
  /** Tool description for the LLM */
  description: string;
  /** JSON Schema for parameter validation */
  parameters: JSONSchema;
  /** Whether this tool requires user approval before execution */
  requiresApproval: boolean | ((params: Record<string, unknown>) => boolean);
  /**
   * Execute the tool with the given parameters.
   * @param params - Parameters passed by the LLM
   * @param context - Execution context with working directory and permissions
   * @returns Result of the tool execution
   */
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/**
 * JSON Schema definition for tool parameters.
 * Used to validate and document tool inputs for the LLM.
 */
export interface JSONSchema {
  /** The type of the schema value */
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  /** Property definitions for object types */
  properties?: Record<string, JSONSchemaProperty>;
  /** List of required property names */
  required?: string[];
  /** Schema for array item types */
  items?: JSONSchema;
}

/**
 * Defines a single property within a JSON Schema.
 */
export interface JSONSchemaProperty {
  /** The property's data type */
  type: string;
  /** Human-readable description of the property */
  description?: string;
  /** Allowed values for enum types */
  enum?: string[];
  /** Default value if not provided */
  default?: unknown;
}

/**
 * Types of permissions that can be granted.
 * - 'read': Permission to read files or directories
 * - 'write': Permission to create or modify files
 * - 'execute': Permission to run shell commands
 */
export type PermissionType = 'read' | 'write' | 'execute';

/**
 * Scope of a permission grant.
 * - 'once': Permission applies only to a single operation
 * - 'session': Permission lasts for the current session
 * - 'permanent': Permission persists across sessions
 */
export type PermissionScope = 'once' | 'session' | 'permanent';

/**
 * Represents a granted permission.
 */
export interface Permission {
  /** Type of permission granted */
  type: PermissionType;
  /** Glob pattern or command prefix the permission applies to */
  pattern: string;
  /** How long the permission lasts */
  scope: PermissionScope;
  /** When the permission was granted */
  grantedAt: Date;
}

/**
 * Request for user approval of an operation.
 * Displayed to the user when a tool requires permission.
 */
export interface PermissionRequest {
  /** Name of the tool requesting permission */
  tool: string;
  /** Description of the operation */
  operation: string;
  /** Specific target (file path or command) */
  details: string;
}

/**
 * Interface for checking permissions.
 * Implemented by PermissionManager to provide access control.
 */
export interface PermissionSet {
  /** All granted permissions */
  grants: Permission[];
  /**
   * Check if reading the given path is allowed.
   * @param path - File or directory path to check
   * @returns True if reading is permitted
   */
  canRead(path: string): boolean;
  /**
   * Check if writing to the given path is allowed.
   * @param path - File path to check
   * @returns True if writing is permitted
   */
  canWrite(path: string): boolean;
  /**
   * Check if executing the given command is allowed.
   * @param command - Shell command to check
   * @returns True if execution is permitted
   */
  canExecute(command: string): boolean;
}

/**
 * Request to the LLM for generating a completion.
 */
export interface CompletionRequest {
  /** Conversation history to provide context */
  messages: Message[];
  /** Available tools the LLM can invoke */
  tools?: ToolDefinition[];
  /** Maximum tokens in the response */
  maxTokens?: number;
  /** Temperature for response randomness (0-1) */
  temperature?: number;
  /** Sequences that will stop generation */
  stopSequences?: string[];
}

/**
 * Response from the LLM.
 */
export interface CompletionResponse {
  /** Text content of the response */
  content: string;
  /** Tool calls requested by the LLM */
  toolCalls: ToolCall[];
  /** Reason generation stopped */
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

/**
 * Chunk emitted during streaming responses.
 * Allows real-time display of LLM output.
 */
export interface StreamChunk {
  /** Type of content in this chunk */
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end';
  /** Text content (for 'text' type) */
  content?: string;
  /** Partial tool call data (for tool_call types) */
  toolCall?: Partial<ToolCall>;
}

/**
 * Interface for LLM providers.
 * Abstracts different LLM APIs (Anthropic, OpenAI, etc.) behind a common interface.
 */
export interface LLMProvider {
  /** Provider name for identification */
  name: string;
  /**
   * Generate a completion synchronously.
   * @param request - The completion request with messages and options
   * @returns The complete response
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  /**
   * Generate a completion with streaming.
   * @param request - The completion request with messages and options
   * @returns Async iterator of stream chunks
   */
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  /**
   * Estimate token count for text.
   * @param text - Text to count tokens for
   * @returns Approximate token count
   */
  countTokens(text: string): number;
}

/**
 * Represents a user session with conversation history and settings.
 * Sessions can be persisted and resumed across CLI invocations.
 */
export interface Session {
  /** Unique session identifier (UUID) */
  id: string;
  /** Working directory for this session */
  workingDirectory: string;
  /** When the session was started */
  startedAt: Date;
  /** Conversation history */
  messages: Message[];
  /** Permissions granted during this session */
  permissions: Permission[];
  /** User preferences for this session */
  settings: SessionSettings;
}

/**
 * User preferences for a session.
 */
export interface SessionSettings {
  /** Color theme for the terminal */
  theme: 'dark' | 'light' | 'auto';
  /** Whether to use colored output */
  colorOutput: boolean;
  /** How much detail to show in output */
  verbosity: 'quiet' | 'normal' | 'verbose';
  /** Whether to stream LLM responses character by character */
  streamResponses: boolean;
  /** Require confirmation before file writes */
  confirmBeforeWrite: boolean;
  /** Automatically approve read operations */
  autoApproveReads: boolean;
  /** Whether to save conversation history to disk */
  saveHistory: boolean;
}

/**
 * Summary of a session for listing purposes.
 * Contains minimal info to display in session lists.
 */
export interface SessionSummary {
  /** Session ID */
  id: string;
  /** Working directory */
  workingDirectory: string;
  /** Start timestamp */
  startedAt: Date;
  /** Number of messages in the conversation */
  messageCount: number;
}

/**
 * Configuration options for the CLI interface.
 * Extends SessionSettings with CLI-specific options.
 */
export interface CLIConfig {
  /** Color theme for the terminal */
  theme: 'dark' | 'light' | 'auto';
  /** Whether to use colored output */
  colorOutput: boolean;
  /** How much detail to show in output */
  verbosity: 'quiet' | 'normal' | 'verbose';
  /** Whether to stream LLM responses character by character */
  streamResponses: boolean;
  /** Require confirmation before file writes */
  confirmBeforeWrite: boolean;
  /** Automatically approve read operations */
  autoApproveReads: boolean;
  /** Whether to save conversation history to disk */
  saveHistory: boolean;
  /** Path to the history file */
  historyPath: string;
}

/**
 * Current state of the agent during execution.
 * Used to track conversation progress and pending operations.
 */
export interface AgentState {
  /** Current conversation ID */
  conversationId: string;
  /** Messages in the current conversation */
  messages: Message[];
  /** Tool calls made during this conversation */
  toolCalls: ToolCall[];
  /** Permission requests awaiting user approval */
  pendingApprovals: PermissionRequest[];
  /** Whether the agent is currently processing a request */
  isRunning: boolean;
}

/**
 * Error thrown when a tool execution fails.
 * Wraps the underlying error with tool context.
 */
export class ToolExecutionError extends Error {
  /**
   * Creates a new ToolExecutionError.
   * @param tool - Name of the tool that failed
   * @param params - Parameters that were passed to the tool
   * @param cause - The underlying error that caused the failure
   */
  constructor(
    public tool: string,
    public params: unknown,
    public cause: Error
  ) {
    super(`Tool ${tool} failed: ${cause.message}`);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Error thrown when the conversation context exceeds the model's limit.
 * Indicates that summarization or truncation is needed.
 */
export class ContextOverflowError extends Error {
  /**
   * Creates a new ContextOverflowError.
   * @param currentTokens - Current token count of the context
   * @param maxTokens - Maximum allowed tokens for the model
   */
  constructor(
    public currentTokens: number,
    public maxTokens: number
  ) {
    super(`Context overflow: ${currentTokens} > ${maxTokens}`);
    this.name = 'ContextOverflowError';
  }
}

/**
 * Error thrown when a permission request is denied by the user.
 */
export class PermissionDeniedError extends Error {
  /**
   * Creates a new PermissionDeniedError.
   * @param request - The permission request that was denied
   */
  constructor(public request: PermissionRequest) {
    super(`Permission denied: ${request.operation}`);
    this.name = 'PermissionDeniedError';
  }
}
