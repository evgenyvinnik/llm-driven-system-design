import { format, isToday, isYesterday, parseISO } from 'date-fns';

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

export function shouldShowDateDivider(current: string, previous: string | undefined): boolean {
  if (!previous) return true;

  const currentDate = format(parseISO(current), 'yyyy-MM-dd');
  const previousDate = format(parseISO(previous), 'yyyy-MM-dd');

  return currentDate !== previousDate;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

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
