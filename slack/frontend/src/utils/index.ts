/**
 * @fileoverview Utility functions for the Slack frontend.
 * Provides date formatting, message grouping, and display helpers.
 */

import { format, isToday, isYesterday, parseISO } from 'date-fns';

/**
 * Formats a message timestamp for display.
 * Shows only time for today, "Yesterday HH:MM" for yesterday,
 * and "Month Day, HH:MM" for older messages.
 * @param dateString - ISO date string to format
 * @returns Formatted time string
 */
export function formatMessageTime(dateString: string): string {
  const date = parseISO(dateString);

  if (isToday(date)) {
    return format(date, 'h:mm a');
  }

  if (isYesterday(date)) {
    return 'Yesterday ' + format(date, 'h:mm a');
  }

  return format(date, 'MMM d, h:mm a');
}

/**
 * Formats a date for the message list divider.
 * Shows "Today", "Yesterday", or the full date for older messages.
 * @param dateString - ISO date string to format
 * @returns Formatted date string for divider display
 */
export function formatDateDivider(dateString: string): string {
  const date = parseISO(dateString);

  if (isToday(date)) {
    return 'Today';
  }

  if (isYesterday(date)) {
    return 'Yesterday';
  }

  return format(date, 'EEEE, MMMM d');
}

/**
 * Determines if a date divider should be shown between two messages.
 * Returns true if the messages are on different calendar days.
 * @param current - ISO date string of the current message
 * @param previous - ISO date string of the previous message, or undefined for the first message
 * @returns True if a date divider should be rendered
 */
export function shouldShowDateDivider(current: string, previous: string | undefined): boolean {
  if (!previous) return true;

  const currentDate = format(parseISO(current), 'yyyy-MM-dd');
  const previousDate = format(parseISO(previous), 'yyyy-MM-dd');

  return currentDate !== previousDate;
}

/**
 * Extracts initials from a name for avatar display.
 * Takes the first letter of each word and returns up to 2 characters.
 * @param name - The full name to extract initials from
 * @returns 1-2 uppercase characters representing the initials
 */
export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/**
 * Groups reactions by emoji for display.
 * Converts a flat list of reactions into grouped counts with user lists.
 * @param reactions - Array of individual reactions, or null
 * @returns Array of grouped reactions with emoji, count, and user IDs
 */
export function groupReactions(
  reactions: Array<{ emoji: string; user_id: string }> | null
): Array<{ emoji: string; count: number; userIds: string[] }> {
  if (!reactions) return [];

  const grouped: Record<string, string[]> = {};

  for (const reaction of reactions) {
    if (!grouped[reaction.emoji]) {
      grouped[reaction.emoji] = [];
    }
    grouped[reaction.emoji].push(reaction.user_id);
  }

  return Object.entries(grouped).map(([emoji, userIds]) => ({
    emoji,
    count: userIds.length,
    userIds,
  }));
}
