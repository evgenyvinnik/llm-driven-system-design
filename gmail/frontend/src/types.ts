export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Thread {
  id: string;
  subject: string;
  snippet: string;
  messageCount: number;
  lastMessageAt: string;
  isRead: boolean;
  isStarred: boolean;
  labels: Label[];
  participants: { id: string; displayName: string; email: string }[];
}

export interface Message {
  id: string;
  threadId: string;
  sender: { id: string; displayName: string; email: string };
  to: { displayName: string; email: string }[];
  cc: { displayName: string; email: string }[];
  /** Only the sender sees the full list; a BCC recipient sees only themself. */
  bcc: { displayName: string; email: string }[];
  bodyText: string;
  bodyHtml: string | null;
  hasAttachments: boolean;
  createdAt: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  isSystem: boolean;
  unreadCount?: number;
}

export interface Draft {
  id: string;
  threadId?: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  version: number;
}

export interface SearchResult {
  threadId: string;
  messageId: string;
  subject: string;
  snippet: string;
  senderName: string;
  senderEmail: string;
  createdAt: string;
  hasAttachments: boolean;
  score: number;
}

export interface Contact {
  id: string;
  email: string;
  name: string | null;
  frequency: number;
}

export interface ThreadDetail {
  id: string;
  subject: string;
  messageCount: number;
  lastMessageAt: string;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isTrashed: boolean;
  isSpam: boolean;
  labels: Label[];
  messages: Message[];
}
