/**
 * Floating Reactions Component
 *
 * Displays animated emoji reactions floating up the screen.
 * Creates a visual feedback effect when users send reactions.
 *
 * @module components/FloatingReactions
 */

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';

/** Map of reaction types to their emoji HTML entities */
const EMOJI_MAP: Record<string, string> = {
  like: '&#128077;',
  love: '&#10084;',
  haha: '&#128514;',
  wow: '&#128558;',
  sad: '&#128546;',
  angry: '&#128544;',
};

/**
 * Renders floating reaction emojis with animation.
 * Automatically removes reactions after animation completes.
 *
 * @returns Floating reactions overlay JSX
 */
export function FloatingReactions() {
  const floatingReactions = useAppStore((state) => state.floatingReactions);
  const removeFloatingReaction = useAppStore((state) => state.removeFloatingReaction);

  // Clean up reactions after animation
  useEffect(() => {
    const cleanup = floatingReactions.map((reaction) => {
      const timeoutId = setTimeout(() => {
        removeFloatingReaction(reaction.id);
      }, 2000);
      return timeoutId;
    });

    return () => {
      cleanup.forEach(clearTimeout);
    };
  }, [floatingReactions, removeFloatingReaction]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {floatingReactions.map((reaction) => (
        <span
          key={reaction.id}
          className="absolute bottom-0 text-3xl animate-float-up"
          style={{
            left: `${10 + Math.random() * 80}%`,
          }}
          dangerouslySetInnerHTML={{ __html: EMOJI_MAP[reaction.type] || reaction.type }}
        />
      ))}
    </div>
  );
}
