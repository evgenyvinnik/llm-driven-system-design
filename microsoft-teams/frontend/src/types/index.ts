export interface User {
  id: string;
  username: string;
  email?: string;
  displayName?: string;
  display_name?: string;
  avatar_url?: string | null;
  role?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_by?: string;
  created_at: string;
  member_role?: string;
}

export interface OrgMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  role: string;
  joined_at: string;
}

export interface Team {
  id: string;
  org_id: string;
  name: string;
  description?: string;
  is_private: boolean;
  created_by?: string;
  created_at: string;
  member_role?: string;
}

export interface TeamMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  role: string;
  joined_at: string;
}

export interface Channel {
  id: string;
  team_id: string;
  name: string;
  description?: string;
  is_private: boolean;
  created_by?: string;
  created_at: string;
  is_member?: boolean;
  /** Messages from other people since the caller's last read. */
  unread_count?: number;
}

export interface ChannelMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  last_read_at: string;
  joined_at: string;
  isOnline?: boolean;
}

export interface Reaction {
  emoji: string;
  count: number;
  users: string[];
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  parent_message_id?: string | null;
  content: string;
  is_edited: boolean;
  /** Set on a deleted message that is kept as a tombstone because it has replies. */
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  reply_count?: number;
  reactions: Reaction[];
  attachments?: MessageAttachment[];
}

/** A file attached to a message, as returned with the message. */
export interface MessageAttachment {
  id: string;
  message_id: string;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
}

export interface FileAttachment {
  id: string;
  message_id?: string | null;
  channel_id: string;
  user_id?: string;
  filename: string;
  content_type?: string | null;
  size_bytes?: number | null;
  created_at: string;
  username?: string;
  display_name?: string;
}

/** Payload of the `message_deleted` SSE event. */
export interface DeletedMessage {
  id: string;
  channel_id: string;
  parent_message_id: string | null;
}
