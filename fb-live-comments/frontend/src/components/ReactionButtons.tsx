/**
 * Reaction Buttons Component
 *
 * Row of emoji reaction buttons for sending reactions to the stream.
 * Supports like, love, haha, wow, sad, and angry reactions.
 *
 * @module components/ReactionButtons
 */

import { ReactionType } from '../types';

/** Props for the ReactionButtons component */
interface ReactionButtonsProps {
  /** Callback when a reaction is clicked */
  onReact: (type: ReactionType) => void;
  /** Whether buttons are disabled (e.g., not connected) */
  disabled?: boolean;
}

/** Available reaction types with their emoji representations */
const REACTIONS: { type: ReactionType; emoji: string; label: string }[] = [
  { type: 'like', emoji: '&#128077;', label: 'Like' },
  { type: 'love', emoji: '&#10084;', label: 'Love' },
  { type: 'haha', emoji: '&#128514;', label: 'Haha' },
  { type: 'wow', emoji: '&#128558;', label: 'Wow' },
  { type: 'sad', emoji: '&#128546;', label: 'Sad' },
  { type: 'angry', emoji: '&#128544;', label: 'Angry' },
];

/**
 * Renders the reaction button row.
 * Each button sends the corresponding reaction type when clicked.
 *
 * @param props - Component props with onReact handler
 * @returns Reaction buttons JSX
 */
export function ReactionButtons({ onReact, disabled }: ReactionButtonsProps) {
  return (
    <div className="flex gap-1 p-2 border-t border-white/10">
      {REACTIONS.map(({ type, emoji, label }) => (
        <button
          key={type}
          onClick={() => onReact(type)}
          disabled={disabled}
          title={label}
          className="flex-1 text-2xl p-2 rounded-lg hover:bg-white/10 active:scale-90 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
          dangerouslySetInnerHTML={{ __html: emoji }}
        />
      ))}
    </div>
  );
}
