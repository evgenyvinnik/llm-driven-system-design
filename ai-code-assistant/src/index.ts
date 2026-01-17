#!/usr/bin/env node
/**
 * AI Code Assistant - Main Entry Point
 *
 * A terminal-based AI coding assistant with tool use and agentic loop.
 */

import { Command } from 'commander';
import * as path from 'path';
import { CLIInterface } from './cli/index.js';
import { AgentController } from './agent/index.js';
import { ToolRegistry } from './tools/index.js';
import { MockLLMProvider } from './llm/index.js';
import { PermissionManager } from './permissions/index.js';
import { SessionManager } from './session/index.js';

const VERSION = '1.0.0';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('ai-assistant')
    .description('AI-powered command-line coding assistant')
    .version(VERSION)
    .option('-d, --directory <path>', 'Working directory', process.cwd())
    .option('-r, --resume <sessionId>', 'Resume a previous session')
    .option('-v, --verbose', 'Verbose output')
    .option('--list-sessions', 'List all saved sessions')
    .argument('[prompt]', 'Initial prompt to send to the assistant')
    .action(async (prompt, options) => {
      await runAssistant(prompt, options);
    });

  program.parse();
}

interface CLIOptions {
  directory: string;
  resume?: string;
  verbose?: boolean;
  listSessions?: boolean;
}

async function runAssistant(initialPrompt: string | undefined, options: CLIOptions): Promise<void> {
  // Initialize components
  const cli = new CLIInterface({
    verbosity: options.verbose ? 'verbose' : 'normal',
  });

  const sessionManager = new SessionManager();

  // Handle list sessions
  if (options.listSessions) {
    const sessions = await sessionManager.list();
    if (sessions.length === 0) {
      console.log('No saved sessions found.');
    } else {
      console.log('Saved sessions:\n');
      for (const session of sessions) {
        console.log(`  ${session.id.slice(0, 8)}  ${session.workingDirectory}  (${session.messageCount} messages)`);
        console.log(`           Started: ${new Date(session.startedAt).toLocaleString()}`);
        console.log();
      }
    }
    return;
  }

  // Resolve working directory
  const workingDirectory = path.resolve(options.directory);

  // Initialize or resume session
  if (options.resume) {
    const resumed = await sessionManager.resume(options.resume);
    if (!resumed) {
      cli.printError(`Session not found: ${options.resume}`);
      cli.close();
      return;
    }
    cli.printInfo(`Resumed session: ${options.resume}`);
  } else {
    await sessionManager.create(workingDirectory);
  }

  // Initialize permission manager
  const permissions = new PermissionManager(workingDirectory, cli);

  // Grant default read permissions for working directory
  permissions.grantPermission('read', `${workingDirectory}/**/*`, 'session');

  // Initialize tool registry
  const tools = new ToolRegistry();

  // Initialize LLM provider (mock for demo)
  const llm = new MockLLMProvider();

  // Initialize agent controller
  const agent = new AgentController(
    llm,
    tools,
    permissions,
    sessionManager,
    cli,
    workingDirectory
  );

  // Show welcome banner
  cli.showWelcome();
  cli.printInfo(`Working directory: ${workingDirectory}`);
  cli.printInfo(`Using mock LLM provider (demo mode)`);
  console.log();

  // Handle initial prompt if provided
  if (initialPrompt) {
    await agent.run(initialPrompt);
  }

  // Main interaction loop
  await runInteractionLoop(cli, agent, sessionManager, tools);
}

async function runInteractionLoop(
  cli: CLIInterface,
  agent: AgentController,
  sessionManager: SessionManager,
  tools: ToolRegistry
): Promise<void> {
  while (true) {
    try {
      const input = await cli.prompt();
      const trimmed = input.trim();

      if (!trimmed) {
        continue;
      }

      // Handle slash commands
      if (trimmed.startsWith('/')) {
        const command = trimmed.toLowerCase();

        switch (command) {
          case '/exit':
          case '/quit':
          case '/q':
            cli.printInfo('Goodbye!');
            await sessionManager.saveCurrent();
            cli.close();
            return;

          case '/help':
          case '/h':
          case '/?':
            cli.showHelp();
            break;

          case '/clear':
            agent.clearHistory();
            cli.printSuccess('Conversation history cleared');
            break;

          case '/session':
            console.log();
            console.log(sessionManager.getSessionInfo());
            console.log();
            break;

          case '/sessions':
            const sessions = await sessionManager.list();
            if (sessions.length === 0) {
              cli.printInfo('No saved sessions');
            } else {
              console.log('\nSaved sessions:');
              for (const s of sessions.slice(0, 10)) {
                console.log(`  ${s.id.slice(0, 8)}  ${s.messageCount} messages  ${new Date(s.startedAt).toLocaleDateString()}`);
              }
              console.log();
            }
            break;

          case '/tools':
            const toolList = tools.getAll().map(t => ({
              name: t.name,
              description: t.description,
            }));
            cli.showTools(toolList);
            break;

          default:
            cli.printError(`Unknown command: ${command}. Type /help for available commands.`);
        }
      } else {
        // Regular input - send to agent
        await agent.run(trimmed);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('readline was closed')) {
        // User pressed Ctrl+C or closed input
        break;
      }
      cli.printError(error instanceof Error ? error.message : String(error));
    }
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\nGoodbye!');
  process.exit(0);
});

// Run main
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
