/**
 * Permission Manager - Safety layer for controlling access to operations
 */

import { minimatch } from 'minimatch';
import type { Permission, PermissionRequest, PermissionSet, PermissionType, PermissionScope } from '../types/index.js';
import type { CLIInterface } from '../cli/interface.js';

// Paths that are always blocked
const BLOCKED_PATHS = [
  '**/.ssh/**',
  '**/.gnupg/**',
  '**/credentials*',
  '**/secrets*',
  '**/.env',
  '**/.env.*',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/id_dsa*',
  '**/*.pem',
  '**/*.key',
];

// Commands that are always blocked
const BLOCKED_COMMANDS = [
  /rm\s+-rf?\s+[\/~]/,
  /mkfs/,
  /dd\s+if=/,
  /:(){:|:&};:/,
  /sudo\s+rm/,
  />\s*\/dev\/sd/,
];

export class PermissionManager implements PermissionSet {
  grants: Permission[] = [];
  private denials: Set<string> = new Set();
  private workingDirectory: string;
  private cli: CLIInterface;

  constructor(workingDirectory: string, cli: CLIInterface) {
    this.workingDirectory = workingDirectory;
    this.cli = cli;
  }

  /**
   * Check if reading a path is allowed
   */
  canRead(path: string): boolean {
    // Check blocked paths
    if (this.isBlockedPath(path)) {
      return false;
    }

    // Reads are generally allowed by default
    return true;
  }

  /**
   * Check if writing to a path is allowed
   */
  canWrite(path: string): boolean {
    // Check blocked paths
    if (this.isBlockedPath(path)) {
      return false;
    }

    // Check if we have a grant for this path
    return this.hasGrant('write', path);
  }

  /**
   * Check if executing a command is allowed
   */
  canExecute(command: string): boolean {
    // Check blocked commands
    if (this.isBlockedCommand(command)) {
      return false;
    }

    // Check if we have a grant for this command
    return this.hasGrant('execute', command);
  }

  /**
   * Request permission for an operation
   */
  async requestPermission(request: PermissionRequest): Promise<boolean> {
    const key = this.requestKey(request);

    // Check if already granted
    if (this.hasGrantForRequest(request)) {
      return true;
    }

    // Check if already denied in this session
    if (this.denials.has(key)) {
      return false;
    }

    // Format the permission request message
    const description = this.formatRequest(request);

    // Ask user
    const approved = await this.cli.confirm(description);

    if (approved) {
      // Create a grant
      const grant = this.createGrant(request);
      this.grants.push(grant);
    } else {
      this.denials.add(key);
    }

    return approved;
  }

  /**
   * Grant permission programmatically
   */
  grantPermission(type: PermissionType, pattern: string, scope: PermissionScope = 'session'): void {
    this.grants.push({
      type,
      pattern,
      scope,
      grantedAt: new Date(),
    });
  }

  /**
   * Check if a path is blocked
   */
  private isBlockedPath(path: string): boolean {
    return BLOCKED_PATHS.some(pattern => minimatch(path, pattern));
  }

  /**
   * Check if a command is blocked
   */
  private isBlockedCommand(command: string): boolean {
    return BLOCKED_COMMANDS.some(pattern => pattern.test(command));
  }

  /**
   * Check if there's a grant for a specific type and path/command
   */
  private hasGrant(type: PermissionType, target: string): boolean {
    return this.grants.some(grant => {
      if (grant.type !== type) return false;

      if (type === 'execute') {
        // For commands, match by prefix
        return target.startsWith(grant.pattern) || grant.pattern === '*';
      } else {
        // For paths, use glob matching
        return minimatch(target, grant.pattern) || target.startsWith(this.workingDirectory);
      }
    });
  }

  /**
   * Check if there's a grant for a request
   */
  private hasGrantForRequest(request: PermissionRequest): boolean {
    const type = this.getRequestType(request);
    return this.hasGrant(type, request.details);
  }

  /**
   * Get the permission type for a request
   */
  private getRequestType(request: PermissionRequest): PermissionType {
    switch (request.tool) {
      case 'Read':
      case 'Glob':
      case 'Grep':
        return 'read';
      case 'Write':
      case 'Edit':
        return 'write';
      case 'Bash':
        return 'execute';
      default:
        return 'execute';
    }
  }

  /**
   * Create a unique key for a request
   */
  private requestKey(request: PermissionRequest): string {
    return `${request.tool}:${request.operation}:${request.details}`;
  }

  /**
   * Create a grant from a request
   */
  private createGrant(request: PermissionRequest): Permission {
    const type = this.getRequestType(request);

    return {
      type,
      pattern: request.details,
      scope: 'session',
      grantedAt: new Date(),
    };
  }

  /**
   * Format a request for user display
   */
  private formatRequest(request: PermissionRequest): string {
    return `${request.tool}: ${request.operation}\n│     Target: ${request.details}`;
  }

  /**
   * Get all grants
   */
  getGrants(): Permission[] {
    return [...this.grants];
  }

  /**
   * Clear session grants
   */
  clearSessionGrants(): void {
    this.grants = this.grants.filter(g => g.scope === 'permanent');
    this.denials.clear();
  }
}
