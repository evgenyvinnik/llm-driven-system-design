import { Link } from '@tanstack/react-router';
import type { SortType } from '../types';

interface SortTabsProps {
  currentSort: SortType;
  baseUrl: string;
}

export function SortTabs({ currentSort, baseUrl }: SortTabsProps) {
  const sorts: { value: SortType; label: string }[] = [
    { value: 'hot', label: 'Hot' },
    { value: 'new', label: 'New' },
    { value: 'top', label: 'Top' },
    { value: 'controversial', label: 'Controversial' },
  ];

  return (
    <div className="flex gap-2 bg-white rounded border border-gray-200 p-2 mb-4">
      {sorts.map((sort) => (
        <Link
          key={sort.value}
          to={`${baseUrl}?sort=${sort.value}`}
          className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
            currentSort === sort.value
              ? 'bg-gray-200 text-gray-900'
              : 'text-gray-500 hover:bg-gray-100'
          }`}
        >
          {sort.label}
        </Link>
      ))}
    </div>
  );
}
