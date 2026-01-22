# AI Code Assistant - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

## Problem Statement

Design the terminal user interface for an AI-powered command-line coding assistant. Key challenges include:
- Real-time streaming response rendering
- Markdown and code syntax highlighting
- Interactive permission prompts
- Progress indicators for long operations
- Keyboard shortcuts and history navigation
- Theming and accessibility

## Requirements Clarification

### Functional Requirements
1. **Input Handling**: Multi-line input, command history, keyboard shortcuts
2. **Streaming Output**: Render LLM responses token-by-token as they arrive
3. **Code Formatting**: Syntax highlighting for code blocks
4. **Permission Prompts**: Clear, interactive approval dialogs
5. **Progress Indicators**: Spinners and status messages for tool execution
6. **Session Display**: Show conversation history and context status

### Non-Functional Requirements
1. **Responsiveness**: No input lag, immediate visual feedback
2. **Cross-Platform**: Consistent behavior on macOS, Linux, Windows terminals
3. **Accessibility**: Clear contrast, screen reader support where possible
4. **Customization**: Theme support, configurable keybindings

### Terminal Constraints
- Limited to ANSI escape codes for styling
- No mouse interaction (keyboard-only)
- Variable terminal widths (80-200+ columns)
- Color support varies by terminal (8, 16, 256, or true color)

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Interface                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Input Layer                               │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │ Readline │  │ History  │  │ Autocmp  │  │ Shortcuts│   │ │
│  │  │  Handler │  │ Manager  │  │  Engine  │  │  Handler │   │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   Rendering Layer                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │ Markdown │  │  Syntax  │  │ Spinner  │  │  Dialog  │   │ │
│  │  │ Renderer │  │Highlight │  │ Animate  │  │ Builder  │   │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                           │                                       │
│                           ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Output Layer                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │  ANSI    │  │  Color   │  │  Layout  │  │ Terminal │   │ │
│  │  │ Encoder  │  │  Theme   │  │  Engine  │  │ Adapter  │   │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Deep Dive: CLI Interface Design

### Configuration Interface

```typescript
interface CLIConfig {
  // Display settings
  theme: 'dark' | 'light' | 'auto';
  colorOutput: boolean;
  verbosity: 'quiet' | 'normal' | 'verbose';

  // Behavior
  streamResponses: boolean;
  confirmBeforeWrite: boolean;
  autoApproveReads: boolean;

  // Session
  saveHistory: boolean;
  historyPath: string;
}
```

### Core CLI Class

```typescript
class CLIInterface {
  private readline: Interface;
  private renderer: MarkdownRenderer;
  private spinner: Spinner;

  async prompt(): Promise<string> {
    return new Promise((resolve) => {
      this.readline.question('> ', resolve);
    });
  }

  async streamOutput(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      process.stdout.write(this.renderer.render(chunk));
    }
  }

  async confirmAction(description: string): Promise<boolean> {
    const answer = await this.prompt(`Allow: ${description}? [y/n] `);
    return answer.toLowerCase() === 'y';
  }
}
```

### Features

- Markdown rendering for code blocks and formatting
- Streaming output with syntax highlighting
- Interactive prompts for permissions
- Progress indicators for long operations
- History navigation with arrow keys

## Deep Dive: Streaming Response Rendering

### The Streaming Challenge

When LLM responses stream token-by-token, we need to:
1. Display text immediately as it arrives
2. Handle incomplete markdown (e.g., partial code blocks)
3. Apply syntax highlighting progressively
4. Manage cursor position for multi-line content

### Streaming Renderer

```typescript
class StreamingRenderer {
  private buffer = '';
  private inCodeBlock = false;
  private codeLanguage = '';

  async render(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      this.buffer += chunk;

      // Render complete lines
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        this.renderLine(line);
      }
    }

    // Render remaining buffer
    if (this.buffer) {
      this.renderLine(this.buffer);
    }
  }

  private renderLine(line: string): void {
    // Detect code block start/end
    if (line.startsWith('```')) {
      this.inCodeBlock = !this.inCodeBlock;
      if (this.inCodeBlock) {
        this.codeLanguage = line.slice(3).trim();
        console.log(chalk.gray(line));
      } else {
        console.log(chalk.gray('```'));
        this.codeLanguage = '';
      }
      return;
    }

    // Apply syntax highlighting in code blocks
    if (this.inCodeBlock) {
      console.log(this.highlightCode(line, this.codeLanguage));
    } else {
      console.log(this.formatMarkdown(line));
    }
  }

  private highlightCode(line: string, language: string): string {
    // Use a syntax highlighting library like 'cli-highlight'
    return highlight(line, { language });
  }

  private formatMarkdown(line: string): string {
    // Bold: **text**
    line = line.replace(/\*\*(.+?)\*\*/g, chalk.bold('$1'));
    // Italic: *text*
    line = line.replace(/\*(.+?)\*/g, chalk.italic('$1'));
    // Inline code: `code`
    line = line.replace(/`(.+?)`/g, chalk.cyan('$1'));
    // Headers
    if (line.startsWith('# ')) {
      return chalk.bold.underline(line.slice(2));
    }
    if (line.startsWith('## ')) {
      return chalk.bold(line.slice(3));
    }
    return line;
  }
}
```

### Token-by-Token Rendering

```typescript
class TokenRenderer {
  private currentLine = '';
  private lineNumber = 0;

  write(token: string): void {
    for (const char of token) {
      if (char === '\n') {
        this.flushLine();
        this.lineNumber++;
      } else {
        this.currentLine += char;
        // Update current line in-place
        process.stdout.write(char);
      }
    }
  }

  private flushLine(): void {
    // Move to start of next line
    process.stdout.write('\n');
    this.currentLine = '';
  }

  // For code blocks, re-render entire line with highlighting
  reRenderCurrentLine(): void {
    // Move cursor to start of line
    process.stdout.write('\r\x1b[K');
    // Re-render with formatting
    process.stdout.write(this.formatLine(this.currentLine));
  }
}
```

## Deep Dive: Terminal UI Components

### Spinner Animation

```typescript
class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private message = '';

  start(message: string): void {
    this.message = message;
    this.frameIndex = 0;

    // Hide cursor
    process.stdout.write('\x1b[?25l');

    this.intervalId = setInterval(() => {
      const frame = this.frames[this.frameIndex];
      process.stdout.write(`\r${chalk.cyan(frame)} ${this.message}`);
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 80);
  }

  update(message: string): void {
    this.message = message;
  }

  stop(finalMessage?: string): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Clear spinner line
    process.stdout.write('\r\x1b[K');

    // Show cursor
    process.stdout.write('\x1b[?25h');

    if (finalMessage) {
      console.log(chalk.green('✓') + ' ' + finalMessage);
    }
  }

  fail(message: string): void {
    this.stop();
    console.log(chalk.red('✗') + ' ' + message);
  }
}
```

### Progress Bar

```typescript
class ProgressBar {
  private width = 40;
  private current = 0;
  private total = 100;
  private label = '';

  update(current: number, total?: number, label?: string): void {
    this.current = current;
    if (total !== undefined) this.total = total;
    if (label !== undefined) this.label = label;

    this.render();
  }

  private render(): void {
    const percentage = Math.min(100, Math.floor((this.current / this.total) * 100));
    const filled = Math.floor((percentage / 100) * this.width);
    const empty = this.width - filled;

    const bar = chalk.cyan('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
    const percentStr = `${percentage}%`.padStart(4);

    process.stdout.write(`\r${bar} ${percentStr} ${this.label}`);
  }

  complete(message?: string): void {
    this.update(this.total);
    process.stdout.write('\n');
    if (message) {
      console.log(chalk.green('✓') + ' ' + message);
    }
  }
}
```

### Permission Dialog

```typescript
class PermissionDialog {
  private theme: Theme;

  async prompt(request: PermissionRequest): Promise<boolean> {
    // Clear any active spinner
    this.spinner?.stop();

    // Display permission request
    console.log();
    console.log(chalk.yellow('━'.repeat(60)));
    console.log(chalk.yellow.bold(' Permission Required'));
    console.log(chalk.yellow('━'.repeat(60)));
    console.log();

    // Show tool and operation
    console.log(chalk.white(' Tool:      ') + chalk.cyan(request.tool));
    console.log(chalk.white(' Operation: ') + request.operation);

    // Show details (file path, command, etc.)
    if (request.details) {
      console.log();
      console.log(chalk.white(' Details:'));
      console.log(chalk.gray(this.indent(request.details, 4)));
    }

    // Show diff preview for edits
    if (request.diff) {
      console.log();
      console.log(chalk.white(' Changes:'));
      this.renderDiff(request.diff);
    }

    console.log();
    console.log(chalk.yellow('━'.repeat(60)));

    // Prompt for approval
    const answer = await this.promptWithOptions([
      { key: 'y', label: 'Yes, allow this', action: 'approve' },
      { key: 'n', label: 'No, deny', action: 'deny' },
      { key: 'a', label: 'Always allow (this session)', action: 'approve_session' },
    ]);

    return answer === 'approve' || answer === 'approve_session';
  }

  private renderDiff(diff: string): void {
    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+')) {
        console.log(chalk.green('    ' + line));
      } else if (line.startsWith('-')) {
        console.log(chalk.red('    ' + line));
      } else {
        console.log(chalk.gray('    ' + line));
      }
    }
  }

  private async promptWithOptions(options: Option[]): Promise<string> {
    const optionText = options
      .map(o => `[${chalk.bold(o.key)}] ${o.label}`)
      .join('  ');

    const answer = await this.readline.question(` ${optionText} `);
    const selected = options.find(o => o.key === answer.toLowerCase());

    return selected?.action || 'deny';
  }

  private indent(text: string, spaces: number): string {
    const prefix = ' '.repeat(spaces);
    return text.split('\n').map(line => prefix + line).join('\n');
  }
}
```

## Deep Dive: Input Handling

### Readline Interface

```typescript
class InputHandler {
  private rl: readline.Interface;
  private history: string[] = [];
  private historyIndex = -1;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 100,
      completer: this.completer.bind(this)
    });

    // Handle special keys
    process.stdin.on('keypress', this.handleKeypress.bind(this));
  }

  async getInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        if (answer.trim()) {
          this.history.push(answer);
          this.historyIndex = this.history.length;
        }
        resolve(answer);
      });
    });
  }

  private handleKeypress(char: string, key: readline.Key): void {
    if (!key) return;

    // Ctrl+C to cancel current operation
    if (key.ctrl && key.name === 'c') {
      this.emit('cancel');
    }

    // Ctrl+D to exit
    if (key.ctrl && key.name === 'd') {
      this.emit('exit');
    }

    // Up/Down for history navigation
    if (key.name === 'up') {
      this.navigateHistory(-1);
    }
    if (key.name === 'down') {
      this.navigateHistory(1);
    }
  }

  private navigateHistory(direction: number): void {
    const newIndex = this.historyIndex + direction;
    if (newIndex >= 0 && newIndex < this.history.length) {
      this.historyIndex = newIndex;
      this.rl.write(null, { ctrl: true, name: 'u' }); // Clear line
      this.rl.write(this.history[newIndex]);
    }
  }

  private completer(line: string): [string[], string] {
    // Autocomplete for slash commands
    const commands = ['/help', '/clear', '/history', '/exit', '/model', '/session'];
    const matches = commands.filter(c => c.startsWith(line));
    return [matches, line];
  }
}
```

### Multi-Line Input

```typescript
class MultiLineInput {
  private lines: string[] = [];
  private cursorLine = 0;
  private cursorColumn = 0;

  async getMultiLineInput(): Promise<string> {
    console.log(chalk.gray('(Enter empty line to submit, Ctrl+C to cancel)'));

    while (true) {
      const line = await this.readline.question(chalk.gray('... '));

      if (line === '') {
        // Empty line submits
        break;
      }

      this.lines.push(line);
    }

    return this.lines.join('\n');
  }

  // Alternative: Use delimiter for multi-line
  async getInputWithDelimiter(delimiter = '<<<'): Promise<string> {
    console.log(chalk.gray(`(Type '${delimiter}' on a new line to submit)`));

    const lines: string[] = [];
    while (true) {
      const line = await this.readline.question('');
      if (line.trim() === delimiter) {
        break;
      }
      lines.push(line);
    }

    return lines.join('\n');
  }
}
```

## Deep Dive: Theming System

### Theme Interface

```typescript
interface Theme {
  name: string;

  // Base colors
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;

  // Semantic colors
  success: string;
  warning: string;
  error: string;
  info: string;

  // UI elements
  prompt: string;
  userMessage: string;
  assistantMessage: string;
  toolOutput: string;
  codeBlock: string;

  // Syntax highlighting
  syntax: {
    keyword: string;
    string: string;
    number: string;
    comment: string;
    function: string;
    variable: string;
    operator: string;
  };
}

const darkTheme: Theme = {
  name: 'dark',

  primary: '#FF6B6B',    // Coral
  secondary: '#4ECDC4',  // Teal
  accent: '#FFE66D',     // Yellow
  background: '#1a1a1a',
  foreground: '#ffffff',

  success: '#4CAF50',
  warning: '#FFE66D',
  error: '#FF6B6B',
  info: '#4ECDC4',

  prompt: '#4ECDC4',
  userMessage: '#ffffff',
  assistantMessage: '#e0e0e0',
  toolOutput: '#888888',
  codeBlock: '#2d2d2d',

  syntax: {
    keyword: '#c792ea',
    string: '#c3e88d',
    number: '#f78c6c',
    comment: '#546e7a',
    function: '#82aaff',
    variable: '#f07178',
    operator: '#89ddff',
  }
};

const lightTheme: Theme = {
  name: 'light',

  primary: '#e53935',
  secondary: '#00897b',
  accent: '#ffc107',
  background: '#ffffff',
  foreground: '#212121',

  success: '#4CAF50',
  warning: '#ff9800',
  error: '#e53935',
  info: '#00897b',

  prompt: '#00897b',
  userMessage: '#212121',
  assistantMessage: '#424242',
  toolOutput: '#757575',
  codeBlock: '#f5f5f5',

  syntax: {
    keyword: '#7c4dff',
    string: '#558b2f',
    number: '#d84315',
    comment: '#90a4ae',
    function: '#1976d2',
    variable: '#c62828',
    operator: '#00838f',
  }
};
```

### Theme Application

```typescript
class ThemeManager {
  private theme: Theme;
  private chalk: typeof chalk;

  constructor(themeName: 'dark' | 'light' | 'auto') {
    if (themeName === 'auto') {
      // Detect terminal background
      this.theme = this.detectTerminalTheme();
    } else {
      this.theme = themeName === 'dark' ? darkTheme : lightTheme;
    }

    // Create custom chalk instance with theme colors
    this.chalk = this.createChalkInstance();
  }

  private detectTerminalTheme(): Theme {
    // Check COLORFGBG environment variable
    const colorFgBg = process.env.COLORFGBG;
    if (colorFgBg) {
      const [fg, bg] = colorFgBg.split(';');
      const bgColor = parseInt(bg, 10);
      // Light backgrounds typically have high values
      return bgColor > 6 ? lightTheme : darkTheme;
    }

    // Default to dark theme
    return darkTheme;
  }

  // Styled output helpers
  prompt(text: string): string {
    return chalk.hex(this.theme.prompt)(text);
  }

  userMessage(text: string): string {
    return chalk.hex(this.theme.userMessage)(text);
  }

  assistantMessage(text: string): string {
    return chalk.hex(this.theme.assistantMessage)(text);
  }

  success(text: string): string {
    return chalk.hex(this.theme.success)(text);
  }

  error(text: string): string {
    return chalk.hex(this.theme.error)(text);
  }

  warning(text: string): string {
    return chalk.hex(this.theme.warning)(text);
  }

  code(text: string, language: string): string {
    // Apply syntax highlighting using theme colors
    return this.highlightSyntax(text, language);
  }
}
```

## Deep Dive: Accessibility

### Color Contrast

```typescript
class AccessibilityChecker {
  // Ensure text meets WCAG AA contrast ratio (4.5:1)
  checkContrast(foreground: string, background: string): boolean {
    const fgLuminance = this.getLuminance(foreground);
    const bgLuminance = this.getLuminance(background);

    const ratio = (Math.max(fgLuminance, bgLuminance) + 0.05) /
                  (Math.min(fgLuminance, bgLuminance) + 0.05);

    return ratio >= 4.5;
  }

  private getLuminance(color: string): number {
    // Parse hex color and calculate relative luminance
    const rgb = this.hexToRgb(color);
    const [r, g, b] = rgb.map(c => {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
}
```

### Screen Reader Support

```typescript
class ScreenReaderSupport {
  // Announce messages for screen readers
  announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
    // Terminal screen readers use different mechanisms
    // We can output ANSI sequences that some screen readers interpret
    if (process.env.TERM === 'screen') {
      // Screen reader mode
      console.log(`\x1b]0;${message}\x07`);
    }
  }

  // Strip formatting for text-to-speech
  getPlainText(formatted: string): string {
    // Remove ANSI escape sequences
    return formatted.replace(/\x1b\[[0-9;]*m/g, '');
  }

  // Describe UI elements
  describeElement(type: string, content: string): string {
    const descriptions: Record<string, string> = {
      'code-block': `Code block: ${content.slice(0, 50)}...`,
      'permission-prompt': `Permission required: ${content}`,
      'tool-result': `Tool output: ${content.slice(0, 100)}`,
      'error': `Error: ${content}`,
    };
    return descriptions[type] || content;
  }
}
```

### Keyboard-Only Navigation

```typescript
class KeyboardNavigation {
  private focusIndex = 0;
  private focusableElements: FocusableElement[] = [];

  registerFocusable(element: FocusableElement): void {
    this.focusableElements.push(element);
  }

  handleTab(shift: boolean): void {
    if (shift) {
      this.focusIndex = Math.max(0, this.focusIndex - 1);
    } else {
      this.focusIndex = Math.min(
        this.focusableElements.length - 1,
        this.focusIndex + 1
      );
    }
    this.focusElement(this.focusableElements[this.focusIndex]);
  }

  handleEnter(): void {
    this.focusableElements[this.focusIndex]?.activate();
  }

  private focusElement(element: FocusableElement): void {
    // Re-render with focus indicator
    this.clearPreviousFocus();
    console.log(chalk.inverse(element.render()));
  }
}
```

## Deep Dive: Layout Engine

### Terminal Width Handling

```typescript
class LayoutEngine {
  private terminalWidth: number;

  constructor() {
    this.terminalWidth = process.stdout.columns || 80;

    // Handle terminal resize
    process.stdout.on('resize', () => {
      this.terminalWidth = process.stdout.columns || 80;
      this.reflow();
    });
  }

  // Word wrap text to fit terminal width
  wrap(text: string, indent: number = 0): string {
    const maxWidth = this.terminalWidth - indent;
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxWidth) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine ? ' ' : '') + word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    const prefix = ' '.repeat(indent);
    return lines.map(line => prefix + line).join('\n');
  }

  // Truncate with ellipsis
  truncate(text: string, maxLength?: number): string {
    const max = maxLength || this.terminalWidth;
    if (text.length <= max) return text;
    return text.slice(0, max - 3) + '...';
  }

  // Center text
  center(text: string): string {
    const padding = Math.max(0, Math.floor((this.terminalWidth - text.length) / 2));
    return ' '.repeat(padding) + text;
  }

  // Create horizontal rule
  hr(char: string = '─'): string {
    return char.repeat(this.terminalWidth);
  }

  // Create box around content
  box(content: string, title?: string): string {
    const lines = content.split('\n');
    const maxLineLength = Math.max(...lines.map(l => l.length));
    const boxWidth = Math.min(maxLineLength + 4, this.terminalWidth);

    const top = title
      ? `┌─ ${title} ${'─'.repeat(boxWidth - title.length - 5)}┐`
      : `┌${'─'.repeat(boxWidth - 2)}┐`;

    const middle = lines.map(line =>
      `│ ${line.padEnd(boxWidth - 4)} │`
    ).join('\n');

    const bottom = `└${'─'.repeat(boxWidth - 2)}┘`;

    return `${top}\n${middle}\n${bottom}`;
  }
}
```

### Conversation Layout

```typescript
class ConversationRenderer {
  private layout: LayoutEngine;
  private theme: ThemeManager;

  renderUserMessage(content: string): void {
    console.log();
    console.log(this.theme.prompt('You: ') + this.theme.userMessage(content));
    console.log();
  }

  renderAssistantMessage(content: string): void {
    console.log();
    console.log(this.theme.prompt('Assistant:'));
    console.log(this.layout.wrap(content, 2));
    console.log();
  }

  renderToolExecution(tool: string, params: unknown): void {
    const paramStr = JSON.stringify(params, null, 2);
    console.log(chalk.gray(`[Executing ${tool}]`));
    if (paramStr.length < 100) {
      console.log(chalk.gray(paramStr));
    }
  }

  renderToolResult(result: ToolResult): void {
    if (result.success) {
      if (result.output) {
        const lines = result.output.split('\n');
        if (lines.length > 20) {
          // Truncate long output
          console.log(chalk.gray(lines.slice(0, 10).join('\n')));
          console.log(chalk.gray(`... (${lines.length - 20} more lines)`));
          console.log(chalk.gray(lines.slice(-10).join('\n')));
        } else {
          console.log(chalk.gray(result.output));
        }
      }
    } else {
      console.log(chalk.red(`Error: ${result.error}`));
    }
  }
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Line-by-line streaming | Immediate feedback, simple state | Can't re-render mid-line formatting |
| ANSI escape codes | Universal terminal support | Limited styling options |
| Built-in readline | Standard, cross-platform | Less control over input handling |
| Sync permission prompts | Clear UX, no race conditions | Blocks other output |
| Fixed spinner frames | Works in all terminals | No fancy animations |
| Theme-based coloring | Consistent branding | May clash with terminal themes |

## Future Frontend Enhancements

1. **Ink/React Integration**: Full React component model for CLI
2. **Mouse Support**: Click-to-approve, scroll through history
3. **Split Pane**: Show file preview alongside conversation
4. **Rich Diffs**: Side-by-side file comparison
5. **Image Rendering**: ASCII art preview of images (sixel support)
6. **Custom Keybindings**: Configurable shortcuts
7. **Plugin Widgets**: Third-party UI components
8. **Web Terminal**: Browser-based interface option
