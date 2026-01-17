import type { Document, User } from '../types';

/** Base URL for API requests (relative to the current origin) */
const API_BASE = '/api';

/**
 * REST API client for document and user management.
 *
 * Provides methods to interact with the backend REST API.
 * Note: Real-time editing is handled via WebSocket, not through this API.
 */
export const api = {
  /**
   * Fetch all documents.
   *
   * @returns Array of document objects, sorted by last update time
   * @throws Error if the request fails
   */
  async getDocuments(): Promise<Document[]> {
    const response = await fetch(`${API_BASE}/documents`);
    if (!response.ok) throw new Error('Failed to fetch documents');
    return response.json();
  },

  /**
   * Fetch a single document by ID.
   *
   * @param id - The document's UUID
   * @returns The document object
   * @throws Error if the request fails or document not found
   */
  async getDocument(id: string): Promise<Document> {
    const response = await fetch(`${API_BASE}/documents/${id}`);
    if (!response.ok) throw new Error('Failed to fetch document');
    return response.json();
  },

  /**
   * Create a new document.
   *
   * @param title - The document title
   * @param ownerId - The ID of the user creating the document
   * @returns The newly created document
   * @throws Error if the request fails
   */
  async createDocument(title: string, ownerId: string): Promise<Document> {
    const response = await fetch(`${API_BASE}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, ownerId }),
    });
    if (!response.ok) throw new Error('Failed to create document');
    return response.json();
  },

  /**
   * Update a document's title.
   *
   * @param id - The document's UUID
   * @param title - The new title
   * @throws Error if the request fails
   */
  async updateDocumentTitle(id: string, title: string): Promise<void> {
    const response = await fetch(`${API_BASE}/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error('Failed to update document');
  },

  /**
   * Fetch all users in the system.
   *
   * @returns Array of user objects
   * @throws Error if the request fails
   */
  async getUsers(): Promise<User[]> {
    const response = await fetch(`${API_BASE}/users`);
    if (!response.ok) throw new Error('Failed to fetch users');
    return response.json();
  },

  /**
   * Fetch a single user by ID.
   *
   * @param id - The user's UUID
   * @returns The user object
   * @throws Error if the request fails or user not found
   */
  async getUser(id: string): Promise<User> {
    const response = await fetch(`${API_BASE}/users/${id}`);
    if (!response.ok) throw new Error('Failed to fetch user');
    return response.json();
  },
};
