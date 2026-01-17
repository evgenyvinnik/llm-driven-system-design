/**
 * Core type definitions for the AI Code Assistant
 */

// Message types for conversation
export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface Message {
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: Date;
}

// Tool system types
export interface ToolCall {
  id: string;
  name: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  toolId: string;
  success: boolean;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  workingDirectory: string;
  permissions: PermissionSet;
  abortSignal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  requiresApproval: boolean | ((params: Record<string, unknown>) => boolean);
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

// JSON Schema for tool parameters
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  items?: JSONSchema;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

// Permission system types
export type PermissionType = 'read' | 'write' | 'execute';
export type PermissionScope = 'once' | 'session' | 'permanent';

export interface Permission {
  type: PermissionType;
  pattern: string;
  scope: PermissionScope;
  grantedAt: Date;
}

export interface PermissionRequest {
  tool: string;
  operation: string;
  details: string;
}

export interface PermissionSet {
  grants: Permission[];
  canRead(path: string): boolean;
  canWrite(path: string): boolean;
  canExecute(command: string): boolean;
}

// LLM Provider types
export interface CompletionRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface CompletionResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
}

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end';
  content?: string;
  toolCall?: Partial<ToolCall>;
}

export interface LLMProvider {
  name: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  countTokens(text: string): number;
}

// Session types
export interface Session {
  id: string;
  workingDirectory: string;
  startedAt: Date;
  messages: Message[];
  permissions: Permission[];
  settings: SessionSettings;
}

export interface SessionSettings {
  theme: 'dark' | 'light' | 'auto';
  colorOutput: boolean;
  verbosity: 'quiet' | 'normal' | 'verbose';
  streamResponses: boolean;
  confirmBeforeWrite: boolean;
  autoApproveReads: boolean;
  saveHistory: boolean;
}

export interface SessionSummary {
  id: string;
  workingDirectory: string;
  startedAt: Date;
  messageCount: number;
}

// CLI Configuration
export interface CLIConfig {
  theme: 'dark' | 'light' | 'auto';
  colorOutput: boolean;
  verbosity: 'quiet' | 'normal' | 'verbose';
  streamResponses: boolean;
  confirmBeforeWrite: boolean;
  autoApproveReads: boolean;
  saveHistory: boolean;
  historyPath: string;
}

// Agent state
export interface AgentState {
  conversationId: string;
  messages: Message[];
  toolCalls: ToolCall[];
  pendingApprovals: PermissionRequest[];
  isRunning: boolean;
}

// Error types
export class ToolExecutionError extends Error {
  constructor(
    public tool: string,
    public params: unknown,
    public cause: Error
  ) {
    super(`Tool ${tool} failed: ${cause.message}`);
    this.name = 'ToolExecutionError';
  }
}

export class ContextOverflowError extends Error {
  constructor(
    public currentTokens: number,
    public maxTokens: number
  ) {
    super(`Context overflow: ${currentTokens} > ${maxTokens}`);
    this.name = 'ContextOverflowError';
  }
}

export class PermissionDeniedError extends Error {
  constructor(public request: PermissionRequest) {
    super(`Permission denied: ${request.operation}`);
    this.name = 'PermissionDeniedError';
  }
}
