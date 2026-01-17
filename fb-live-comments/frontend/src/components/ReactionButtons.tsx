import { ReactionType } from '../types';

interface ReactionButtonsProps {
  onReact: (type: ReactionType) => void;
  disabled?: boolean;
}

const REACTIONS: { type: ReactionType; emoji: string; label: string }[] = [
  { type: 'like', emoji: '&#128077;', label: 'Like' },
  { type: 'love', emoji: '&#10084;', label: 'Love' },
  { type: 'haha', emoji: '&#128514;', label: 'Haha' },
  { type: 'wow', emoji: '&#128558;', label: 'Wow' },
  { type: 'sad', emoji: '&#128546;', label: 'Sad' },
  { type: 'angry', emoji: '&#128544;', label: 'Angry' },
];

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
