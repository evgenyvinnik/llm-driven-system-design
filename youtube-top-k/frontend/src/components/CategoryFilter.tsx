import { useTrendingStore } from '../stores/trendingStore';

const CATEGORIES = [
  { id: 'all', label: 'All', icon: '🔥' },
  { id: 'music', label: 'Music', icon: '🎵' },
  { id: 'gaming', label: 'Gaming', icon: '🎮' },
  { id: 'sports', label: 'Sports', icon: '⚽' },
  { id: 'news', label: 'News', icon: '📰' },
  { id: 'entertainment', label: 'Entertainment', icon: '🎬' },
  { id: 'education', label: 'Education', icon: '📚' },
];

export function CategoryFilter() {
  const { selectedCategory, setSelectedCategory, trending } = useTrendingStore();

  return (
    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
      {CATEGORIES.map((category) => {
        const count = trending[category.id]?.videos?.length || 0;
        return (
          <button
            key={category.id}
            onClick={() => setSelectedCategory(category.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full whitespace-nowrap transition-colors ${
              selectedCategory === category.id
                ? 'bg-white text-black'
                : 'bg-youtube-gray hover:bg-gray-600 text-white'
            }`}
          >
            <span>{category.icon}</span>
            <span className="font-medium">{category.label}</span>
            {count > 0 && (
              <span className="text-xs bg-youtube-red text-white px-1.5 py-0.5 rounded-full">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
