interface DifficultyBadgeProps {
  difficulty: 'easy' | 'medium' | 'hard';
}

export function DifficultyBadge({ difficulty }: DifficultyBadgeProps) {
  const colors = {
    easy: 'text-green-400 bg-green-400/10',
    medium: 'text-yellow-400 bg-yellow-400/10',
    hard: 'text-red-400 bg-red-400/10',
  };

  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${colors[difficulty]}`}
    >
      {difficulty}
    </span>
  );
}
