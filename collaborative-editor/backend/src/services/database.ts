import pg from 'pg';
import type { User, Document, DocumentSnapshot, OperationRecord, OperationData } from '../types/index.js';

const { Pool } = pg;

// Database connection pool
const pool = new Pool({
  user: process.env.DB_USER || 'collab',
  password: process.env.DB_PASSWORD || 'collab123',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'collaborative_editor',
});

export const db = {
  async query<T = unknown>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
    return pool.query(text, params);
  },

  async getUser(userId: string): Promise<User | null> {
    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string;
      color: string;
    }>(
      'SELECT id, username, display_name, color FROM users WHERE id = $1',
      [userId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      color: row.color,
    };
  },

  async getUsers(): Promise<User[]> {
    const result = await pool.query<{
      id: string;
      username: string;
      display_name: string;
      color: string;
    }>('SELECT id, username, display_name, color FROM users ORDER BY username');
    return result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      color: row.color,
    }));
  },

  async getDocument(documentId: string): Promise<Document | null> {
    const result = await pool.query<{
      id: string;
      title: string;
      owner_id: string;
      created_at: Date;
      updated_at: Date;
    }>(
      'SELECT id, title, owner_id, created_at, updated_at FROM documents WHERE id = $1',
      [documentId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },

  async getDocuments(): Promise<Document[]> {
    const result = await pool.query<{
      id: string;
      title: string;
      owner_id: string;
      created_at: Date;
      updated_at: Date;
    }>('SELECT id, title, owner_id, created_at, updated_at FROM documents ORDER BY updated_at DESC');
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  },

  async createDocument(title: string, ownerId: string): Promise<Document> {
    const result = await pool.query<{
      id: string;
      title: string;
      owner_id: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO documents (title, owner_id)
       VALUES ($1, $2)
       RETURNING id, title, owner_id, created_at, updated_at`,
      [title, ownerId]
    );
    const row = result.rows[0];

    // Create initial empty snapshot
    await pool.query(
      `INSERT INTO document_snapshots (document_id, version, content) VALUES ($1, 0, '')`,
      [row.id]
    );

    return {
      id: row.id,
      title: row.title,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },

  async updateDocumentTitle(documentId: string, title: string): Promise<void> {
    await pool.query(
      'UPDATE documents SET title = $1, updated_at = NOW() WHERE id = $2',
      [title, documentId]
    );
  },

  async getLatestSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    const result = await pool.query<{
      document_id: string;
      version: number;
      content: string;
      created_at: Date;
    }>(
      `SELECT document_id, version, content, created_at
       FROM document_snapshots
       WHERE document_id = $1
       ORDER BY version DESC
       LIMIT 1`,
      [documentId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      documentId: row.document_id,
      version: row.version,
      content: row.content,
      createdAt: row.created_at,
    };
  },

  async saveSnapshot(
    documentId: string,
    version: number,
    content: string
  ): Promise<void> {
    await pool.query(
      `INSERT INTO document_snapshots (document_id, version, content)
       VALUES ($1, $2, $3)
       ON CONFLICT (document_id, version) DO UPDATE SET content = $3`,
      [documentId, version, content]
    );
  },

  async getOperationsSince(
    documentId: string,
    version: number
  ): Promise<OperationRecord[]> {
    const result = await pool.query<{
      id: string;
      document_id: string;
      version: number;
      client_id: string;
      user_id: string;
      operation: OperationData;
      created_at: Date;
    }>(
      `SELECT id, document_id, version, client_id, user_id, operation, created_at
       FROM operations
       WHERE document_id = $1 AND version > $2
       ORDER BY version`,
      [documentId, version]
    );
    return result.rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      version: row.version,
      clientId: row.client_id,
      userId: row.user_id,
      operation: row.operation,
      createdAt: row.created_at,
    }));
  },

  async saveOperation(
    documentId: string,
    version: number,
    clientId: string,
    userId: string,
    operation: OperationData
  ): Promise<void> {
    await pool.query(
      `INSERT INTO operations (document_id, version, client_id, user_id, operation)
       VALUES ($1, $2, $3, $4, $5)`,
      [documentId, version, clientId, userId, JSON.stringify(operation)]
    );

    // Update document timestamp
    await pool.query(
      'UPDATE documents SET updated_at = NOW() WHERE id = $1',
      [documentId]
    );
  },

  async close(): Promise<void> {
    await pool.end();
  },
};
