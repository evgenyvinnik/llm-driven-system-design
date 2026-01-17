/**
 * Mock LLM Provider - Simulates LLM responses for demo purposes
 *
 * This provider parses user input and generates appropriate tool calls
 * to demonstrate the agentic loop without requiring an actual LLM API.
 */

import type {
  LLMProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ToolCall,
  Message,
} from '../types/index.js';

/**
 * Pattern matching for common user intents
 */
interface IntentPattern {
  pattern: RegExp;
  handler: (match: RegExpMatchArray, messages: Message[]) => MockResponse;
}

interface MockResponse {
  text: string;
  toolCalls: ToolCall[];
}

export class MockLLMProvider implements LLMProvider {
  name = 'mock';
  private callCount = 0;

  private patterns: IntentPattern[] = [
    // Read file patterns
    {
      pattern: /(?:read|show|display|view|open|cat)\s+(?:the\s+)?(?:file\s+)?(.+\.(ts|js|json|md|txt|py|go|rs|tsx|jsx))/i,
      handler: (match) => this.handleReadFile(match[1]),
    },
    // List/find files patterns
    {
      pattern: /(?:list|find|show|search for)\s+(?:all\s+)?(?:files|(\*\.\w+)|(\w+\s+files))\s*(?:in\s+)?(.+)?/i,
      handler: (match) => this.handleListFiles(match),
    },
    // Glob pattern
    {
      pattern: /(?:glob|find)\s+(.+)/i,
      handler: (match) => this.handleGlob(match[1]),
    },
    // Grep/search patterns
    {
      pattern: /(?:search|grep|find)\s+(?:for\s+)?["']?([^"']+)["']?\s+(?:in\s+)?(.+)?/i,
      handler: (match) => this.handleGrep(match[1], match[2]),
    },
    // Edit file patterns
    {
      pattern: /(?:edit|modify|change|update|fix)\s+(?:the\s+)?(?:file\s+)?(.+\.(ts|js|json|md|txt))/i,
      handler: (match) => this.handleEditFile(match[1]),
    },
    // Create file patterns
    {
      pattern: /(?:create|write|make)\s+(?:a\s+)?(?:new\s+)?(?:file\s+)?(.+\.(ts|js|json|md|txt))/i,
      handler: (match) => this.handleCreateFile(match[1]),
    },
    // Run command patterns
    {
      pattern: /(?:run|execute|do)\s+(.+)/i,
      handler: (match) => this.handleRunCommand(match[1]),
    },
    // Git patterns
    {
      pattern: /(?:git\s+)?(status|log|diff|branch)/i,
      handler: (match) => this.handleGitCommand(match[1]),
    },
    // Help patterns
    {
      pattern: /(?:help|what can you do|how do I|capabilities)/i,
      handler: () => this.handleHelp(),
    },
  ];

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const chunks = [];
    for await (const chunk of this.stream(request)) {
      chunks.push(chunk);
    }

    // Combine chunks
    const text = chunks
      .filter(c => c.type === 'text' && c.content)
      .map(c => c.content)
      .join('');

    const toolCalls: ToolCall[] = [];
    let currentToolCall: Partial<ToolCall> | null = null;

    for (const chunk of chunks) {
      if (chunk.type === 'tool_call_start' && chunk.toolCall) {
        currentToolCall = { ...chunk.toolCall };
      } else if (chunk.type === 'tool_call_end' && currentToolCall) {
        toolCalls.push(currentToolCall as ToolCall);
        currentToolCall = null;
      }
    }

    return {
      content: text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    this.callCount++;

    // Get the last user message
    const lastUserMessage = [...request.messages]
      .reverse()
      .find(m => m.role === 'user');

    // Check if this is a tool result continuation
    const lastMessage = request.messages[request.messages.length - 1];
    if (lastMessage.role === 'tool') {
      // Generate a response based on tool results
      yield* this.streamToolResultResponse(request.messages);
      return;
    }

    if (!lastUserMessage) {
      yield { type: 'text', content: 'How can I help you today?' };
      return;
    }

    const input = lastUserMessage.content;

    // Try to match a pattern
    for (const { pattern, handler } of this.patterns) {
      const match = input.match(pattern);
      if (match) {
        const response = handler(match, request.messages);
        yield* this.streamResponse(response);
        return;
      }
    }

    // Default response for unmatched input
    yield* this.streamResponse(this.handleUnknown(input));
  }

  countTokens(text: string): number {
    // Simple approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private async *streamResponse(response: MockResponse): AsyncIterable<StreamChunk> {
    // Stream text character by character with delay for demo effect
    for (const char of response.text) {
      yield { type: 'text', content: char };
      await this.delay(5); // Small delay for streaming effect
    }

    // Emit tool calls
    for (const toolCall of response.toolCalls) {
      yield { type: 'tool_call_start', toolCall };
      await this.delay(50);
      yield { type: 'tool_call_end', toolCall };
    }
  }

  private async *streamToolResultResponse(messages: Message[]): AsyncIterable<StreamChunk> {
    // Find the tool results
    const toolResults = messages
      .filter(m => m.role === 'tool')
      .flatMap(m => m.toolResults || []);

    const successResults = toolResults.filter(r => r.success);
    const failedResults = toolResults.filter(r => !r.success);

    let responseText = '';

    if (successResults.length > 0 && failedResults.length === 0) {
      responseText = 'The operation completed successfully. ';
      if (successResults[0].output) {
        const preview = successResults[0].output.slice(0, 200);
        if (successResults[0].output.length > 200) {
          responseText += `Here's a preview of the result:\n\n${preview}...\n\nThe full output is shown above.`;
        } else {
          responseText += 'The result is shown above.';
        }
      }
    } else if (failedResults.length > 0) {
      responseText = `I encountered an error: ${failedResults[0].error}. Would you like me to try a different approach?`;
    } else {
      responseText = 'I\'ve completed the requested operation. Is there anything else you\'d like me to do?';
    }

    for (const char of responseText) {
      yield { type: 'text', content: char };
      await this.delay(5);
    }
  }

  private handleReadFile(filePath: string): MockResponse {
    const cleanPath = filePath.trim();
    return {
      text: `I'll read the file \`${cleanPath}\` for you.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Read',
          parameters: { file_path: cleanPath },
        },
      ],
    };
  }

  private handleListFiles(match: RegExpMatchArray): MockResponse {
    const extension = match[1] || match[2]?.split(' ')[0] || '*';
    const dir = match[3]?.trim() || '.';
    const pattern = extension === '*' ? '**/*' : `**/*.${extension.replace(/^\*\./, '')}`;

    return {
      text: `I'll find all matching files in \`${dir}\`.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Glob',
          parameters: { pattern, path: dir },
        },
      ],
    };
  }

  private handleGlob(pattern: string): MockResponse {
    return {
      text: `I'll search for files matching \`${pattern}\`.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Glob',
          parameters: { pattern: pattern.trim() },
        },
      ],
    };
  }

  private handleGrep(searchPattern: string, path?: string): MockResponse {
    const searchPath = path?.trim() || '.';
    return {
      text: `I'll search for \`${searchPattern}\` in the codebase.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Grep',
          parameters: {
            pattern: searchPattern.trim(),
            path: searchPath,
          },
        },
      ],
    };
  }

  private handleEditFile(filePath: string): MockResponse {
    return {
      text: `I'll first read the file \`${filePath}\` to understand its current content before making changes.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Read',
          parameters: { file_path: filePath.trim() },
        },
      ],
    };
  }

  private handleCreateFile(filePath: string): MockResponse {
    const extension = filePath.split('.').pop() || 'txt';
    let content = '';

    switch (extension) {
      case 'ts':
        content = '// TypeScript file\n\nexport function main(): void {\n  console.log("Hello, World!");\n}\n';
        break;
      case 'js':
        content = '// JavaScript file\n\nfunction main() {\n  console.log("Hello, World!");\n}\n\nmodule.exports = { main };\n';
        break;
      case 'json':
        content = '{\n  "name": "new-file",\n  "version": "1.0.0"\n}\n';
        break;
      case 'md':
        content = '# New Document\n\nThis is a new markdown file.\n';
        break;
      default:
        content = '// New file\n';
    }

    return {
      text: `I'll create a new ${extension} file at \`${filePath}\`.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Write',
          parameters: {
            file_path: filePath.trim(),
            content,
          },
        },
      ],
    };
  }

  private handleRunCommand(command: string): MockResponse {
    return {
      text: `I'll execute the command for you.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Bash',
          parameters: { command: command.trim() },
        },
      ],
    };
  }

  private handleGitCommand(subcommand: string): MockResponse {
    const command = `git ${subcommand}`;
    return {
      text: `I'll run \`${command}\` for you.\n\n`,
      toolCalls: [
        {
          id: `call_${this.callCount}_1`,
          name: 'Bash',
          parameters: { command },
        },
      ],
    };
  }

  private handleHelp(): MockResponse {
    return {
      text: `I'm an AI coding assistant that can help you with various tasks:

**File Operations:**
- Read files: "Read src/index.ts" or "Show me the package.json"
- Edit files: "Edit the main.ts file" or "Fix the bug in utils.js"
- Create files: "Create a new config.json" or "Write a README.md"

**Search & Navigation:**
- Find files: "Find all TypeScript files" or "List *.json files in config/"
- Search content: "Search for 'TODO' in the codebase" or "Grep for 'function main'"

**Commands:**
- Run commands: "Run npm test" or "Execute ls -la"
- Git operations: "Git status" or "Show git log"

Just describe what you want to do in natural language, and I'll help you accomplish it!
`,
      toolCalls: [],
    };
  }

  private handleUnknown(input: string): MockResponse {
    // For demo purposes, try to interpret the input as a general task
    if (input.length < 10) {
      return {
        text: `I'm not sure what you'd like me to do. Could you please be more specific? You can say things like:
- "Read the file package.json"
- "Find all TypeScript files"
- "Search for 'function' in src/"
- "Run npm test"

Type "/help" for more examples.
`,
        toolCalls: [],
      };
    }

    // Default to showing help
    return {
      text: `I understand you want to: "${input}"

Let me try to help with that. Could you be more specific about:
1. Which file(s) are involved?
2. What specific action should I take?

For example: "Read src/index.ts" or "Search for 'TODO' in the codebase"
`,
      toolCalls: [],
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
