import { customAlphabet } from 'nanoid';

// ============ Type Definitions ============

interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ============ Video ID Generation ============

// YouTube-style video ID: 11 characters, URL-safe
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const generateVideoId = customAlphabet(ALPHABET, 11);

export { generateVideoId };

// ============ Duration Formatting ============

/**
 * Format duration from seconds to HH:MM:SS or MM:SS
 */
export const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Parse duration string to seconds
 */
export const parseDuration = (durationStr: string): number => {
  const parts = durationStr.split(':').map(Number);
  if (parts.length === 3) {
    return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  } else if (parts.length === 2) {
    return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  }
  return parts[0] ?? 0;
};

// ============ Count Formatting ============

/**
 * Format view count (1.2M, 500K, etc.)
 */
export const formatViewCount = (count: number): string => {
  if (count >= 1000000000) {
    return `${(count / 1000000000).toFixed(1)}B`;
  }
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
};

// ============ Time Formatting ============

/**
 * Calculate time ago string
 */
export const timeAgo = (date: Date | string): string => {
  const now = new Date();
  const past = new Date(date);
  const diffMs = now.getTime() - past.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffYears > 0) return `${diffYears} year${diffYears > 1 ? 's' : ''} ago`;
  if (diffMonths > 0) return `${diffMonths} month${diffMonths > 1 ? 's' : ''} ago`;
  if (diffWeeks > 0) return `${diffWeeks} week${diffWeeks > 1 ? 's' : ''} ago`;
  if (diffDays > 0) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  if (diffHours > 0) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  if (diffMinutes > 0) return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
  return 'Just now';
};

// ============ Input Sanitization ============

/**
 * Sanitize user input
 */
export const sanitizeInput = <T>(input: T): T => {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '') as unknown as T;
};

// ============ Validation Functions ============

/**
 * Validate video title
 */
export const validateTitle = (title: unknown): ValidationResult => {
  if (!title || typeof title !== 'string') {
    return { valid: false, error: 'Title is required' };
  }
  if (title.length < 1 || title.length > 100) {
    return { valid: false, error: 'Title must be between 1 and 100 characters' };
  }
  return { valid: true };
};

/**
 * Validate username
 */
export const validateUsername = (username: unknown): ValidationResult => {
  if (!username || typeof username !== 'string') {
    return { valid: false, error: 'Username is required' };
  }
  if (username.length < 3 || username.length > 50) {
    return { valid: false, error: 'Username must be between 3 and 50 characters' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return {
      valid: false,
      error: 'Username can only contain letters, numbers, underscores, and hyphens',
    };
  }
  return { valid: true };
};

/**
 * Validate email
 */
export const validateEmail = (email: unknown): ValidationResult => {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }
  return { valid: true };
};

// ============ Password Hashing ============

/**
 * Simple hash for passwords (in production, use bcrypt)
 */
export const hashPassword = async (password: string): Promise<string> => {
  // Simple hash for demo - in production use bcrypt
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  const computed = await hashPassword(password);
  return computed === hash;
};
