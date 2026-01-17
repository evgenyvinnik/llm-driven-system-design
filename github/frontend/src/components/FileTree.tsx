import { Link } from '@tanstack/react-router';
import { Folder, FileText, ChevronRight } from 'lucide-react';
import type { TreeItem } from '../types';

interface FileTreeProps {
  items: TreeItem[];
  owner: string;
  repo: string;
  branch: string;
  currentPath?: string;
}

export function FileTree({ items, owner, repo, branch, currentPath }: FileTreeProps) {
  // Sort: directories first, then files, alphabetically
  const sortedItems = [...items].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });

  return (
    <div className="border border-github-border rounded-md overflow-hidden">
      {/* Breadcrumb */}
      {currentPath && (
        <div className="px-4 py-2 bg-github-surface border-b border-github-border flex items-center space-x-1 text-sm">
          <Link
            to={`/${owner}/${repo}`}
            className="text-github-accent hover:underline"
          >
            {repo}
          </Link>
          {currentPath.split('/').map((part, index, arr) => (
            <span key={index} className="flex items-center">
              <ChevronRight className="w-4 h-4 text-github-muted" />
              {index === arr.length - 1 ? (
                <span className="text-github-text">{part}</span>
              ) : (
                <Link
                  to={`/${owner}/${repo}/tree/${branch}/${arr.slice(0, index + 1).join('/')}`}
                  className="text-github-accent hover:underline"
                >
                  {part}
                </Link>
              )}
            </span>
          ))}
        </div>
      )}

      {/* File list */}
      <table className="w-full">
        <tbody>
          {sortedItems.map((item) => (
            <tr
              key={item.sha + item.name}
              className="border-b border-github-border last:border-b-0 hover:bg-github-surface/50"
            >
              <td className="px-4 py-2">
                <Link
                  to={
                    item.type === 'dir'
                      ? `/${owner}/${repo}/tree/${branch}/${item.path}`
                      : `/${owner}/${repo}/blob/${branch}/${item.path}`
                  }
                  className="flex items-center space-x-2 text-github-text hover:text-github-accent"
                >
                  {item.type === 'dir' ? (
                    <Folder className="w-4 h-4 text-github-accent" />
                  ) : (
                    <FileText className="w-4 h-4 text-github-muted" />
                  )}
                  <span>{item.name}</span>
                </Link>
              </td>
              <td className="px-4 py-2 text-right text-sm text-github-muted">
                {item.size && formatSize(item.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
