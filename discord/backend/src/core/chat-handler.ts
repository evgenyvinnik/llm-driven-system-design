import type {
  Session,
  ParsedCommand,
  CommandResult,
  ChatMessage,
} from '../types/index.js';
import { commandParser } from './command-parser.js';
import { connectionManager } from './connection-manager.js';
import { roomManager } from './room-manager.js';
import { historyBuffer } from './history-buffer.js';
import { messageRouter } from './message-router.js';
import * as dbOps from '../db/index.js';
import { logger } from '../utils/logger.js';

export class ChatHandler {
  /**
   * Handle a command or message from a session
   */
  async handleInput(sessionId: string, input: string): Promise<CommandResult> {
    const session = connectionManager.getSession(sessionId);
    if (!session) {
      return { success: false, message: 'Session not found' };
    }

    const command = commandParser.parse(input);
    return this.executeCommand(session, command);
  }

  /**
   * Execute a parsed command
   */
  private async executeCommand(
    session: Session,
    command: ParsedCommand
  ): Promise<CommandResult> {
    try {
      switch (command.type) {
        case 'help':
          return this.handleHelp();

        case 'nick':
          return this.handleNick(session, command.args);

        case 'list':
          return this.handleList(session);

        case 'quit':
          return this.handleQuit(session);

        case 'create':
          return this.handleCreate(session, command.args);

        case 'join':
          return this.handleJoin(session, command.args);

        case 'rooms':
          return this.handleRooms();

        case 'leave':
          return this.handleLeave(session);

        case 'dm':
          return this.handleDM(session, command.args);

        case 'message':
          return this.handleMessage(session, command.args);

        default:
          return { success: false, message: 'Unknown command' };
      }
    } catch (error) {
      logger.error('Error executing command', { command, error });
      return {
        success: false,
        message: error instanceof Error ? error.message : 'An error occurred',
      };
    }
  }

  /**
   * /help - Display available commands
   */
  private handleHelp(): CommandResult {
    return {
      success: true,
      message: commandParser.getHelpText(),
    };
  }

  /**
   * /nick <name> - Change nickname
   */
  private async handleNick(
    session: Session,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return { success: false, message: 'Usage: /nick <new_nickname>' };
    }

    const newNickname = args[0];

    // Validate nickname
    if (newNickname.length < 2 || newNickname.length > 50) {
      return {
        success: false,
        message: 'Nickname must be between 2 and 50 characters',
      };
    }

    // Check if nickname is taken
    const existing = await dbOps.getUserByNickname(newNickname);
    if (existing && existing.id !== session.userId) {
      return { success: false, message: 'Nickname is already taken' };
    }

    const oldNickname = session.nickname;

    // Update in database
    await dbOps.updateNickname(session.userId, newNickname);

    // Update session
    connectionManager.updateNickname(session.sessionId, newNickname);

    // Broadcast to current room if in one
    if (session.currentRoom) {
      messageRouter.sendSystemMessage(
        session.currentRoom,
        `${oldNickname} is now known as ${newNickname}`
      );
    }

    return {
      success: true,
      message: `Nickname changed from ${oldNickname} to ${newNickname}`,
    };
  }

  /**
   * /list - List users in current room
   */
  private handleList(session: Session): CommandResult {
    if (!session.currentRoom) {
      return {
        success: false,
        message: 'You are not in a room. Use /join <room> to join one.',
      };
    }

    const sessions = connectionManager.getSessionsInRoom(session.currentRoom);
    const users = sessions.map((s) => s.nickname);

    return {
      success: true,
      message: `Users in ${session.currentRoom}: ${users.join(', ')}`,
      data: { users },
    };
  }

  /**
   * /quit - Disconnect
   */
  private async handleQuit(session: Session): Promise<CommandResult> {
    // Leave current room if in one
    if (session.currentRoom) {
      await this.handleLeave(session);
    }

    // Disconnect will be handled by the adapter
    return {
      success: true,
      message: 'Goodbye!',
      data: { disconnect: true },
    };
  }

  /**
   * /create <room> - Create a new room
   */
  private async handleCreate(
    session: Session,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return { success: false, message: 'Usage: /create <room_name>' };
    }

    const roomName = args[0].toLowerCase();

    // Validate room name
    if (roomName.length < 2 || roomName.length > 100) {
      return {
        success: false,
        message: 'Room name must be between 2 and 100 characters',
      };
    }

    if (!/^[a-z0-9_-]+$/.test(roomName)) {
      return {
        success: false,
        message: 'Room name can only contain lowercase letters, numbers, underscores, and hyphens',
      };
    }

    try {
      await roomManager.createRoom(roomName, session.userId);

      // Auto-join the created room
      return this.handleJoin(session, [roomName]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        return { success: false, message: error.message };
      }
      throw error;
    }
  }

  /**
   * /join <room> - Join an existing room
   */
  private async handleJoin(
    session: Session,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return { success: false, message: 'Usage: /join <room_name>' };
    }

    const roomName = args[0].toLowerCase();

    // Check if room exists
    const room = await roomManager.getRoom(roomName);
    if (!room) {
      return {
        success: false,
        message: `Room "${roomName}" does not exist. Use /create <room> to create it.`,
      };
    }

    // Leave current room if in one
    if (session.currentRoom && session.currentRoom !== roomName) {
      await this.handleLeave(session);
    }

    // Join the new room
    await roomManager.joinRoom(roomName, session.userId);
    connectionManager.setCurrentRoom(session.sessionId, roomName);

    // Get message history
    const history = historyBuffer.getHistory(roomName);

    // Notify room members
    messageRouter.sendSystemMessage(roomName, `${session.nickname} joined the room`);

    // Format history for display
    const historyText = history.length > 0
      ? history
          .map((m) => `[${m.roomName}] ${m.nickname}: ${m.content}`)
          .join('\n')
      : 'No recent messages';

    return {
      success: true,
      message: `Joined room: ${roomName}\n--- Recent Messages ---\n${historyText}\n---`,
      data: { room: roomName, history },
    };
  }

  /**
   * /rooms - List all available rooms
   */
  private async handleRooms(): Promise<CommandResult> {
    const rooms = await roomManager.listRooms();

    if (rooms.length === 0) {
      return {
        success: true,
        message: 'No rooms available. Use /create <room> to create one.',
        data: { rooms: [] },
      };
    }

    const roomList = rooms
      .map((r) => `  ${r.name} (${r.memberCount} members)`)
      .join('\n');

    return {
      success: true,
      message: `Available rooms:\n${roomList}`,
      data: { rooms },
    };
  }

  /**
   * /leave - Leave current room
   */
  private async handleLeave(session: Session): Promise<CommandResult> {
    if (!session.currentRoom) {
      return {
        success: false,
        message: 'You are not in a room.',
      };
    }

    const roomName = session.currentRoom;

    // Notify room members before leaving
    messageRouter.sendSystemMessage(roomName, `${session.nickname} left the room`);

    // Leave the room
    await roomManager.leaveRoom(roomName, session.userId);
    connectionManager.setCurrentRoom(session.sessionId, null);

    return {
      success: true,
      message: `Left room: ${roomName}`,
    };
  }

  /**
   * /dm <user> <message> - Send direct message
   */
  private async handleDM(
    session: Session,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return { success: false, message: 'Usage: /dm <username> <message>' };
    }

    const targetNickname = args[0];
    const content = args.slice(1).join(' ');

    // Find target user
    const targetUser = await dbOps.getUserByNickname(targetNickname);
    if (!targetUser) {
      return { success: false, message: `User "${targetNickname}" not found` };
    }

    // Check if user is online
    if (!connectionManager.isUserOnline(targetUser.id)) {
      return { success: false, message: `User "${targetNickname}" is offline` };
    }

    // Send DM
    messageRouter.sendDirectMessage(session.nickname, targetUser.id, content);

    return {
      success: true,
      message: `DM sent to ${targetNickname}`,
    };
  }

  /**
   * Handle a regular chat message
   */
  private async handleMessage(
    session: Session,
    args: string[]
  ): Promise<CommandResult> {
    if (!session.currentRoom) {
      return {
        success: false,
        message: 'You are not in a room. Use /join <room> to join one.',
      };
    }

    const content = args.join(' ');
    if (!content) {
      return { success: false, message: 'Message cannot be empty' };
    }

    const room = await roomManager.getRoom(session.currentRoom);
    if (!room) {
      return { success: false, message: 'Room not found' };
    }

    // Save message to history buffer
    const savedMessage = await historyBuffer.addMessage(
      session.currentRoom,
      room.id,
      session.userId,
      session.nickname,
      content
    );

    // Create chat message object
    const chatMessage: ChatMessage = {
      room: session.currentRoom,
      user: session.nickname,
      content,
      timestamp: savedMessage.createdAt,
      messageId: savedMessage.id,
    };

    // Broadcast to room (including sender for confirmation)
    messageRouter.broadcastToRoom(session.currentRoom, chatMessage);

    return {
      success: true,
      message: '',
      data: { messageId: savedMessage.id },
    };
  }

  /**
   * Handle user disconnect
   */
  async handleDisconnect(sessionId: string): Promise<void> {
    const session = connectionManager.getSession(sessionId);
    if (!session) return;

    // Leave current room
    if (session.currentRoom) {
      messageRouter.sendSystemMessage(
        session.currentRoom,
        `${session.nickname} disconnected`
      );
      await roomManager.leaveRoom(session.currentRoom, session.userId);
    }

    // Remove session
    connectionManager.disconnect(sessionId);
  }
}

export const chatHandler = new ChatHandler();
export default chatHandler;
