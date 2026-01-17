import net from 'net';
import { v4 as uuidv4 } from 'uuid';
import { connectionManager, chatHandler } from '../core/index.js';
import * as dbOps from '../db/index.js';
import { logger } from '../utils/logger.js';

interface TCPClientState {
  sessionId: string | null;
  buffer: string;
  authenticated: boolean;
  waitingForNickname: boolean;
}

export class TCPServer {
  private server: net.Server;
  private port: number;
  private clients: Map<net.Socket, TCPClientState> = new Map();

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
   * Start the TCP server
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
   * Stop the TCP server
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
   * Handle a new client connection
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
   * Handle incoming data from a client
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
   * Handle nickname input during authentication
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
   * Handle a command or message from an authenticated client
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
   * Handle client disconnect
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
   * Send a message to a client
   */
  private send(socket: net.Socket, message: string): void {
    if (!socket.destroyed) {
      socket.write(message + '\n');
    }
  }

  /**
   * Get the number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

export default TCPServer;
