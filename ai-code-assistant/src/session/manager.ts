/**
 * Session Manager - Persistence of conversation history and settings.
 *
 * This module handles session persistence, allowing conversations to be
 * saved and resumed across CLI invocations. Sessions store the complete
 * conversation history, permission grants, and user preferences.
 *
 * Sessions are stored as JSON files in the user's home directory
 * (~/.ai-assistant/sessions/).
 *
 * @module session/manager
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { Session, SessionSettings, SessionSummary, Message, Permission } from '../types/index.js';

/**
 * Default session settings applied to new sessions.
 */
const DEFAULT_SETTINGS: SessionSettings = {
  theme: 'dark',
  colorOutput: true,
  verbosity: 'normal',
  streamResponses: true,
  confirmBeforeWrite: true,
  autoApproveReads: true,
  saveHistory: true,
};

/**
 * Manages session persistence and state.
 *
 * The SessionManager provides:
 * - Session creation with unique UUIDs
 * - Session persistence to JSON files
 * - Session resumption from saved state
 * - Message and permission tracking
 * - Session listing and deletion
 *
 * Usage:
 * 1. Create a new session with create(workingDir)
 * 2. Add messages with addMessage(msg)
 * 3. Session auto-saves on agent completion
 * 4. Resume later with resume(sessionId)
 */
export class SessionManager {
  /** Directory where session files are stored */
  private sessionDir: string;
  /** Currently active session, if any */
  private currentSession: Session | null = null;

  /**
   * Creates a new SessionManager.
   * @param sessionDir - Directory for session storage (defaults to ~/.ai-assistant/sessions)
   */
  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir || path.join(os.homedir(), '.ai-assistant', 'sessions');
  }

  /**
   * Create a new session with a unique ID.
   * Automatically saves the session to disk.
   * @param workingDir - The working directory for this session
   * @returns The newly created session
   */
  async create(workingDir: string): Promise<Session> {
    const session: Session = {
      id: crypto.randomUUID(),
      workingDirectory: workingDir,
      startedAt: new Date(),
      messages: [],
      permissions: [],
      settings: { ...DEFAULT_SETTINGS },
    };

    this.currentSession = session;
    await this.save(session);
    return session;
  }

  /**
   * Resume an existing session from disk.
   * @param sessionId - The UUID of the session to resume
   * @returns The resumed session, or null if not found
   */
  async resume(sessionId: string): Promise<Session | null> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);

    try {
      const data = await fs.readFile(sessionPath, 'utf-8');
      const session = JSON.parse(data) as Session;

      // Convert date strings back to Date objects
      session.startedAt = new Date(session.startedAt);
      session.messages.forEach(m => {
        m.timestamp = new Date(m.timestamp);
      });
      session.permissions.forEach(p => {
        p.grantedAt = new Date(p.grantedAt);
      });

      this.currentSession = session;
      return session;
    } catch {
      return null;
    }
  }

  /**
   * Save a session to disk.
   * Creates the session directory if it doesn't exist.
   * @param session - The session to save
   */
  async save(session: Session): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const sessionPath = path.join(this.sessionDir, `${session.id}.json`);
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Save the current session to disk.
   * No-op if no session is active.
   */
  async saveCurrent(): Promise<void> {
    if (this.currentSession) {
      await this.save(this.currentSession);
    }
  }

  /**
   * Get the currently active session.
   * @returns The current session, or null if none is active
   */
  getCurrent(): Session | null {
    return this.currentSession;
  }

  /**
   * Add a message to the current session.
   * @param message - The message to add
   */
  addMessage(message: Message): void {
    if (this.currentSession) {
      this.currentSession.messages.push(message);
    }
  }

  /**
   * Get all messages from the current session.
   * @returns Array of messages, or empty array if no session
   */
  getMessages(): Message[] {
    return this.currentSession?.messages || [];
  }

  /**
   * Clear all messages from the current session.
   * Used for /clear command.
   */
  clearMessages(): void {
    if (this.currentSession) {
      this.currentSession.messages = [];
    }
  }

  /**
   * Add a permission grant to the current session.
   * @param permission - The permission to add
   */
  addPermission(permission: Permission): void {
    if (this.currentSession) {
      this.currentSession.permissions.push(permission);
    }
  }

  /**
   * Get all permissions from the current session.
   * @returns Array of permissions, or empty array if no session
   */
  getPermissions(): Permission[] {
    return this.currentSession?.permissions || [];
  }

  /**
   * List all saved sessions.
   * Returns summaries sorted by most recent first.
   * @returns Array of session summaries
   */
  async list(): Promise<SessionSummary[]> {
    try {
      await fs.mkdir(this.sessionDir, { recursive: true });
      const files = await fs.readdir(this.sessionDir);
      const sessions: SessionSummary[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const data = await fs.readFile(path.join(this.sessionDir, file), 'utf-8');
            const session = JSON.parse(data) as Session;
            sessions.push({
              id: session.id,
              workingDirectory: session.workingDirectory,
              startedAt: new Date(session.startedAt),
              messageCount: session.messages.length,
            });
          } catch {
            // Skip invalid session files
            continue;
          }
        }
      }

      // Sort by most recent first
      return sessions.sort((a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      );
    } catch {
      return [];
    }
  }

  /**
   * Delete a saved session.
   * @param sessionId - The UUID of the session to delete
   * @returns True if deleted, false if not found
   */
  async delete(sessionId: string): Promise<boolean> {
    const sessionPath = path.join(this.sessionDir, `${sessionId}.json`);
    try {
      await fs.unlink(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get a formatted info string for the current session.
   * Used for /session command display.
   * @returns Formatted session information
   */
  getSessionInfo(): string {
    if (!this.currentSession) {
      return 'No active session';
    }

    const session = this.currentSession;
    const duration = Date.now() - new Date(session.startedAt).getTime();
    const minutes = Math.floor(duration / 60000);

    return `Session: ${session.id.slice(0, 8)}...
Working directory: ${session.workingDirectory}
Started: ${new Date(session.startedAt).toLocaleString()}
Duration: ${minutes} minutes
Messages: ${session.messages.length}
Permissions granted: ${session.permissions.length}`;
  }
}
