import { Stream, User, Comment } from '../types';

const API_BASE = '/api';

export async function fetchStreams(): Promise<Stream[]> {
  const response = await fetch(`${API_BASE}/streams`);
  if (!response.ok) throw new Error('Failed to fetch streams');
  return response.json();
}

export async function fetchStream(streamId: string): Promise<Stream> {
  const response = await fetch(`${API_BASE}/streams/${streamId}`);
  if (!response.ok) throw new Error('Failed to fetch stream');
  return response.json();
}

export async function fetchComments(streamId: string, limit = 50): Promise<Comment[]> {
  const response = await fetch(`${API_BASE}/streams/${streamId}/comments?limit=${limit}`);
  if (!response.ok) throw new Error('Failed to fetch comments');
  return response.json();
}

export async function fetchUsers(): Promise<User[]> {
  const response = await fetch(`${API_BASE}/users`);
  if (!response.ok) throw new Error('Failed to fetch users');
  return response.json();
}

export async function fetchUser(userId: string): Promise<User> {
  const response = await fetch(`${API_BASE}/users/${userId}`);
  if (!response.ok) throw new Error('Failed to fetch user');
  return response.json();
}

export async function createStream(
  title: string,
  creatorId: string,
  description?: string,
  videoUrl?: string
): Promise<Stream> {
  const response = await fetch(`${API_BASE}/streams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      creator_id: creatorId,
      description,
      video_url: videoUrl,
    }),
  });
  if (!response.ok) throw new Error('Failed to create stream');
  return response.json();
}

export async function endStream(streamId: string): Promise<Stream> {
  const response = await fetch(`${API_BASE}/streams/${streamId}/end`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error('Failed to end stream');
  return response.json();
}
