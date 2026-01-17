/**
 * CLI Interface - Terminal interaction layer
 */

import * as readline from 'readline';
import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import type { CLIConfig } from '../types/index.js';

export class CLIInterface {
  private rl: readline.Interface;
  private spinner: Ora | null = null;
  private config: CLIConfig;

  constructor(config: Partial<CLIConfig> = {}) {
    this.config = {
      theme: 'dark',
      colorOutput: true,
      verbosity: 'normal',
      streamResponses: true,
      confirmBeforeWrite: true,
      autoApproveReads: true,
      saveHistory: true,
      historyPath: '.ai-assistant-history',
      ...config,
    };

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
  }

  /**
   * Display welcome banner
   */
  showWelcome(): void {
    const banner = `
${chalk.cyan('╔══════════════════════════════════════════════════════════════╗')}
${chalk.cyan('║')}           ${chalk.bold.white('AI Code Assistant')} ${chalk.gray('v1.0.0')}                        ${chalk.cyan('║')}
${chalk.cyan('║')}                                                              ${chalk.cyan('║')}
${chalk.cyan('║')}  ${chalk.gray('An intelligent CLI coding assistant with tool use')}           ${chalk.cyan('║')}
${chalk.cyan('║')}                                                              ${chalk.cyan('║')}
${chalk.cyan('║')}  ${chalk.yellow('Commands:')}                                                   ${chalk.cyan('║')}
${chalk.cyan('║')}    ${chalk.green('/help')}     - Show available commands                      ${chalk.cyan('║')}
${chalk.cyan('║')}    ${chalk.green('/clear')}    - Clear conversation history                   ${chalk.cyan('║')}
${chalk.cyan('║')}    ${chalk.green('/session')}  - Show session info                            ${chalk.cyan('║')}
${chalk.cyan('║')}    ${chalk.green('/exit')}     - Exit the assistant                           ${chalk.cyan('║')}
${chalk.cyan('║')}                                                              ${chalk.cyan('║')}
${chalk.cyan('╚══════════════════════════════════════════════════════════════╝')}
`;
    console.log(banner);
  }

  /**
   * Prompt for user input
   */
  async prompt(promptText: string = '> '): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(chalk.cyan(promptText), (answer) => {
        resolve(answer);
      });
    });
  }

  /**
   * Confirm an action with the user
   */
  async confirm(description: string): Promise<boolean> {
    console.log();
    console.log(chalk.yellow('┌─ Permission Required ─────────────────────────────────────────┐'));
    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('│  ') + description);
    console.log(chalk.yellow('│'));
    console.log(chalk.yellow('└────────────────────────────────────────────────────────────────┘'));

    const answer = await this.prompt(chalk.yellow('Allow? [y/n/a] (a=always) '));
    const normalized = answer.toLowerCase().trim();
    return normalized === 'y' || normalized === 'yes' || normalized === 'a' || normalized === 'always';
  }

  /**
   * Show a spinner for long operations
   */
  startSpinner(text: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }
    this.spinner = ora({
      text: chalk.gray(text),
      spinner: 'dots',
    }).start();
  }

  /**
   * Stop the spinner
   */
  stopSpinner(success: boolean = true, text?: string): void {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(text ? chalk.green(text) : undefined);
      } else {
        this.spinner.fail(text ? chalk.red(text) : undefined);
      }
      this.spinner = null;
    }
  }

  /**
   * Stream output character by character
   */
  async streamOutput(stream: AsyncIterable<string>): Promise<void> {
    for await (const chunk of stream) {
      process.stdout.write(chunk);
    }
    console.log(); // End with newline
  }

  /**
   * Print assistant message with formatting
   */
  printAssistant(content: string): void {
    console.log();
    console.log(chalk.blue('┌─ Assistant ─────────────────────────────────────────────────────┐'));
    console.log(chalk.blue('│'));

    // Format content with proper indentation
    const lines = content.split('\n');
    for (const line of lines) {
      console.log(chalk.blue('│  ') + this.formatLine(line));
    }

    console.log(chalk.blue('│'));
    console.log(chalk.blue('└─────────────────────────────────────────────────────────────────┘'));
    console.log();
  }

  /**
   * Print tool call information
   */
  printToolCall(toolName: string, params: Record<string, unknown>): void {
    console.log();
    console.log(chalk.magenta(`⚡ Tool: ${toolName}`));

    // Pretty print parameters
    for (const [key, value] of Object.entries(params)) {
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const displayValue = valueStr.length > 50 ? valueStr.slice(0, 47) + '...' : valueStr;
      console.log(chalk.gray(`   ${key}: ${displayValue}`));
    }
  }

  /**
   * Print tool result
   */
  printToolResult(success: boolean, output?: string, error?: string): void {
    if (success) {
      console.log(chalk.green('   ✓ Success'));
      if (output && this.config.verbosity === 'verbose') {
        const lines = output.split('\n').slice(0, 10);
        for (const line of lines) {
          console.log(chalk.gray(`     ${line}`));
        }
        if (output.split('\n').length > 10) {
          console.log(chalk.gray('     ... (truncated)'));
        }
      }
    } else {
      console.log(chalk.red('   ✗ Failed'));
      if (error) {
        console.log(chalk.red(`     ${error}`));
      }
    }
  }

  /**
   * Print error message
   */
  printError(message: string): void {
    console.log();
    console.log(chalk.red('┌─ Error ──────────────────────────────────────────────────────────┐'));
    console.log(chalk.red('│  ') + message);
    console.log(chalk.red('└──────────────────────────────────────────────────────────────────┘'));
    console.log();
  }

  /**
   * Print info message
   */
  printInfo(message: string): void {
    console.log(chalk.gray(`ℹ ${message}`));
  }

  /**
   * Print success message
   */
  printSuccess(message: string): void {
    console.log(chalk.green(`✓ ${message}`));
  }

  /**
   * Format a line with syntax highlighting for code
   */
  private formatLine(line: string): string {
    // Check for code block markers
    if (line.startsWith('```')) {
      return chalk.gray(line);
    }

    // Simple inline code highlighting
    const codeRegex = /`([^`]+)`/g;
    return line.replace(codeRegex, (_match, code: string) => chalk.cyan(code));
  }

  /**
   * Show help
   */
  showHelp(): void {
    console.log();
    console.log(chalk.bold('Available Commands:'));
    console.log();
    console.log(chalk.green('  /help      ') + chalk.gray('Show this help message'));
    console.log(chalk.green('  /clear     ') + chalk.gray('Clear conversation history'));
    console.log(chalk.green('  /session   ') + chalk.gray('Show current session information'));
    console.log(chalk.green('  /sessions  ') + chalk.gray('List all saved sessions'));
    console.log(chalk.green('  /tools     ') + chalk.gray('List available tools'));
    console.log(chalk.green('  /exit      ') + chalk.gray('Exit the assistant'));
    console.log();
    console.log(chalk.bold('Examples:'));
    console.log();
    console.log(chalk.gray('  "Read the file src/index.ts"'));
    console.log(chalk.gray('  "Find all TypeScript files in src/"'));
    console.log(chalk.gray('  "Edit the function foo to add error handling"'));
    console.log(chalk.gray('  "Run npm test"'));
    console.log();
  }

  /**
   * Show available tools
   */
  showTools(tools: { name: string; description: string }[]): void {
    console.log();
    console.log(chalk.bold('Available Tools:'));
    console.log();
    for (const tool of tools) {
      console.log(chalk.green(`  ${tool.name.padEnd(12)}`), chalk.gray(tool.description));
    }
    console.log();
  }

  /**
   * Close the interface
   */
  close(): void {
    this.rl.close();
  }
}
