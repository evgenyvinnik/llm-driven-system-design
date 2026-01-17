/**
 * TCP Server Adapter
 *
 * Provides a raw TCP interface for the chat system, allowing connections
 * via netcat or telnet. This adapter handles socket lifecycle, line-based
 * input buffering, and nickname authentication.
 *
 * Protocol:
 * - Line-based text protocol (newline-delimited)
 * - User must provide nickname on first input
 * - Commands start with "/" (e.g., /join, /help)
 * - All other input is treated as chat messages
 *
 * Example usage:
 *   nc localhost 9001
 *   > Enter nickname: alice
 *   > /join general
 *   > Hello, world!
 */

import net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { connectionManager, chatHandler } from '../core/index.js';
import * as dbOps from '../db/index.js';
import { logger } from '../utils/logger.js';

/**
 * Internal state for tracking a TCP client connection.
 */
interface TCPClientState {
  /** Session ID once authenticated, null before authentication */
  sessionId: string | null;
  /** Buffer for incomplete line input */
  buffer: string;
  /** Whether the client has completed authentication */
  authenticated: boolean;
  /** Whether we are waiting for nickname input */
  waitingForNickname: boolean;
}

/**
 * TCP server for Baby Discord.
 *
 * Implements the Adapter pattern to provide a TCP interface over
 * the core chat functionality. Handles socket connections, authentication,
 * and message routing.
 */
export class TCPServer {
  /** Node.js TCP server instance */
  private server: net.Server;
  /** Port to listen on */
  private port: number;
  /** Map of socket to client state for tracking connections */
  private clients: Map<net.Socket, TCPClientState> = new Map();

  /**
   * Create a new TCP server.
   *
   * @param port - Port number to listen on (default: 9001)
   */
  constructor(port: number = 9001) {
    this.port = port;
    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on('error', (err) => {
      logger.error('TCP Server error', { error: err });
    });

    this.server.on('close', () => {
      logger.info('TCP Server closed');
    });
  }

  /**
   * Start the TCP server and begin accepting connections.
   *
   * @returns Promise that resolves when server is listening
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.info(`TCP Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the TCP server and close all client connections.
   *
   * @returns Promise that resolves when server is fully stopped
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all client connections
      for (const [socket] of this.clients) {
        socket.destroy();
      }
      this.clients.clear();

      this.server.close(() => {
        logger.info('TCP Server stopped');
        resolve();
      });
    });
  }

  /**
   * Handle a new client connection.
   * Sets up event handlers and prompts for nickname.
   *
   * @param socket - The new client socket
   */
  private handleConnection(socket: net.Socket): void {
    const clientAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info('New TCP connection', { clientAddr });

    // Initialize client state
    const state: TCPClientState = {
      sessionId: null,
      buffer: '',
      authenticated: false,
      waitingForNickname: true,
    };
    this.clients.set(socket, state);

    // Send welcome message
    this.send(socket, 'Welcome to Baby Discord!');
    this.send(socket, 'Enter your nickname: ');

    // Handle incoming data
    socket.on('data', (data) => {
      this.handleData(socket, data);
    });

    // Handle client disconnect
    socket.on('close', () => {
      this.handleClose(socket);
    });

    // Handle errors
    socket.on('error', (err) => {
      logger.error('Socket error', { clientAddr, error: err.message });
    });

    // Set keep-alive
    socket.setKeepAlive(true, 60000);
  }

  /**
   * Handle incoming data from a client.
   * Buffers input until complete lines are received, then processes each line.
   *
   * @param socket - The client socket
   * @param data - Raw data buffer from socket
   */
  private async handleData(socket: net.Socket, data: Buffer): Promise<void> {
    const state = this.clients.get(socket);
    if (!state) return;

    // Append to buffer
    state.buffer += data.toString();

    // Process complete lines
    const lines = state.buffer.split('\n');
    state.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (state.waitingForNickname) {
        await this.handleNicknameInput(socket, state, trimmed);
      } else if (state.sessionId) {
        await this.handleCommand(socket, state, trimmed);
      }
    }
  }

  /**
   * Handle nickname input during authentication.
   * Validates nickname, creates user if needed, and establishes session.
   *
   * @param socket - The client socket
   * @param state - Client state object
   * @param nickname - The submitted nickname
   */
  private async handleNicknameInput(
    socket: net.Socket,
    state: TCPClientState,
    nickname: string
  ): Promise<void> {
    // Validate nickname
    if (nickname.length < 2 || nickname.length > 50) {
      this.send(socket, 'Nickname must be between 2 and 50 characters. Try again: ');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(nickname)) {
      this.send(socket, 'Nickname can only contain letters, numbers, underscores, and hyphens. Try again: ');
      return;
    }

    try {
      // Get or create user
      const user = await dbOps.getOrCreateUser(nickname);

      // Create session
      const sessionId = uuidv4();
      const sendFn = (msg: string) => this.send(socket, msg);

      connectionManager.connect(sessionId, user.id, user.nickname, 'tcp', sendFn);

      state.sessionId = sessionId;
      state.authenticated = true;
      state.waitingForNickname = false;

      this.send(socket, '');
      this.send(socket, `Welcome, ${user.nickname}!`);
      this.send(socket, 'Type /help for available commands.');
      this.send(socket, '');

      logger.info('TCP client authenticated', {
        sessionId,
        userId: user.id,
        nickname: user.nickname,
      });
    } catch (error) {
      logger.error('Failed to authenticate TCP client', { nickname, error });
      this.send(socket, 'Failed to authenticate. Please try a different nickname: ');
    }
  }

  /**
   * Handle a command or message from an authenticated client.
   * Passes input to ChatHandler and sends response back.
   *
   * @param socket - The client socket
   * @param state - Client state object
   * @param input - The command or message input
   */
  private async handleCommand(
    socket: net.Socket,
    state: TCPClientState,
    input: string
  ): Promise<void> {
    if (!state.sessionId) return;

    const result = await chatHandler.handleInput(state.sessionId, input);

    // Send response if there's a message (skip for chat messages to avoid echo)
    if (result.message) {
      this.send(socket, result.message);
    }

    // Handle disconnect command
    if (result.data?.disconnect) {
      await chatHandler.handleDisconnect(state.sessionId);
      socket.end();
    }
  }

  /**
   * Handle client disconnect.
   * Cleans up session and removes from tracking.
   *
   * @param socket - The disconnected socket
   */
  private async handleClose(socket: net.Socket): Promise<void> {
    const state = this.clients.get(socket);

    if (state?.sessionId) {
      await chatHandler.handleDisconnect(state.sessionId);
    }

    this.clients.delete(socket);
    logger.info('TCP client disconnected');
  }

  /**
   * Send a message to a client.
   * Appends newline for line-based protocol.
   *
   * @param socket - Target socket
   * @param message - Message string to send
   */
  private send(socket: net.Socket, message: string): void {
    if (!socket.destroyed) {
      socket.write(message + '\n');
    }
  }

  /**
   * Get the number of connected clients.
   *
   * @returns Number of active TCP connections
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

export default TCPServer;
