/**
 * Session Manager - Persistence of conversation history and settings
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import type { Session, SessionSettings, SessionSummary, Message, Permission } from '../types/index.js';

const DEFAULT_SETTINGS: SessionSettings = {
  theme: 'dark',
  colorOutput: true,
  verbosity: 'normal',
  streamResponses: true,
  confirmBeforeWrite: true,
  autoApproveReads: true,
  saveHistory: true,
};

export class SessionManager {
  private sessionDir: string;
  private currentSession: Session | null = null;

  constructor(sessionDir?: string) {
    this.sessionDir = sessionDir || path.join(os.homedir(), '.ai-assistant', 'sessions');
  }

  /**
   * Create a new session
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
   * Resume an existing session
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
   * Save session to disk
   */
  async save(session: Session): Promise<void> {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const sessionPath = path.join(this.sessionDir, `${session.id}.json`);
    await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
  }

  /**
   * Save current session
   */
  async saveCurrent(): Promise<void> {
    if (this.currentSession) {
      await this.save(this.currentSession);
    }
  }

  /**
   * Get current session
   */
  getCurrent(): Session | null {
    return this.currentSession;
  }

  /**
   * Add a message to current session
   */
  addMessage(message: Message): void {
    if (this.currentSession) {
      this.currentSession.messages.push(message);
    }
  }

  /**
   * Get messages from current session
   */
  getMessages(): Message[] {
    return this.currentSession?.messages || [];
  }

  /**
   * Clear messages from current session
   */
  clearMessages(): void {
    if (this.currentSession) {
      this.currentSession.messages = [];
    }
  }

  /**
   * Add permission to current session
   */
  addPermission(permission: Permission): void {
    if (this.currentSession) {
      this.currentSession.permissions.push(permission);
    }
  }

  /**
   * Get permissions from current session
   */
  getPermissions(): Permission[] {
    return this.currentSession?.permissions || [];
  }

  /**
   * List all sessions
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
   * Delete a session
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
   * Get session info for display
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
