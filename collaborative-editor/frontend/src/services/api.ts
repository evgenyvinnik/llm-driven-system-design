import type { Document, User } from '../types';

const API_BASE = '/api';

export const api = {
  async getDocuments(): Promise<Document[]> {
    const response = await fetch(`${API_BASE}/documents`);
    if (!response.ok) throw new Error('Failed to fetch documents');
    return response.json();
  },

  async getDocument(id: string): Promise<Document> {
    const response = await fetch(`${API_BASE}/documents/${id}`);
    if (!response.ok) throw new Error('Failed to fetch document');
    return response.json();
  },

  async createDocument(title: string, ownerId: string): Promise<Document> {
    const response = await fetch(`${API_BASE}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, ownerId }),
    });
    if (!response.ok) throw new Error('Failed to create document');
    return response.json();
  },

  async updateDocumentTitle(id: string, title: string): Promise<void> {
    const response = await fetch(`${API_BASE}/documents/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error('Failed to update document');
  },

  async getUsers(): Promise<User[]> {
    const response = await fetch(`${API_BASE}/users`);
    if (!response.ok) throw new Error('Failed to fetch users');
    return response.json();
  },

  async getUser(id: string): Promise<User> {
    const response = await fetch(`${API_BASE}/users/${id}`);
    if (!response.ok) throw new Error('Failed to fetch user');
    return response.json();
  },
};
