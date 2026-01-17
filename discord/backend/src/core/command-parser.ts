import type { ParsedCommand, CommandType } from '../types/index.js';

const COMMANDS: Record<string, CommandType> = {
  help: 'help',
  nick: 'nick',
  list: 'list',
  quit: 'quit',
  create: 'create',
  join: 'join',
  rooms: 'rooms',
  leave: 'leave',
  dm: 'dm',
};

export class CommandParser {
  /**
   * Parse a raw input line into a command or message
   * Commands start with /
   * Everything else is treated as a message
   */
  parse(input: string): ParsedCommand {
    const trimmed = input.trim();

    if (!trimmed) {
      return { type: 'message', args: [], raw: '' };
    }

    // Check if it's a command (starts with /)
    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      if (command in COMMANDS) {
        return {
          type: COMMANDS[command],
          args,
          raw: trimmed,
        };
      }

      // Unknown command - treat as message but could also return error
      return {
        type: 'message',
        args: [trimmed],
        raw: trimmed,
      };
    }

    // Regular message
    return {
      type: 'message',
      args: [trimmed],
      raw: trimmed,
    };
  }

  /**
   * Get help text for all available commands
   */
  getHelpText(): string {
    return `Available commands:
  /help         - Show this message
  /nick <name>  - Change your nickname
  /list         - List users in current room
  /quit         - Disconnect from server
  /create <room>- Create a new room
  /join <room>  - Join an existing room
  /rooms        - List all available rooms
  /leave        - Leave current room
  /dm <user> <message> - Send direct message`;
  }
}

export const commandParser = new CommandParser();
export default commandParser;
