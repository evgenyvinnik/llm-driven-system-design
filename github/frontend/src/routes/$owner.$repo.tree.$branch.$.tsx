import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { FileTree } from '../components/FileTree';
import { ChevronRight, Folder } from 'lucide-react';
import type { TreeItem } from '../types';

export const Route = createFileRoute('/$owner/$repo/tree/$branch/$')({
  component: TreePage,
});

function TreePage() {
  const { owner, repo, branch } = useParams({ from: '/$owner/$repo/tree/$branch/$' });
  const path = Route.useParams()['_splat'] || '';
  const [tree, setTree] = useState<TreeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTree() {
      setLoading(true);
      try {
        const data = await api.getTree(owner, repo, branch, path);
        setTree(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetchTree();
  }, [owner, repo, branch, path]);

  const pathParts = path ? path.split('/') : [];

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-github-muted">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-github-danger">{error}</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <div className="flex items-center space-x-1 mb-4 text-sm">
        <Link to={`/${owner}/${repo}`} className="text-github-accent hover:underline">
          {repo}
        </Link>
        {pathParts.map((part, index) => (
          <span key={index} className="flex items-center">
            <ChevronRight className="w-4 h-4 text-github-muted" />
            {index === pathParts.length - 1 ? (
              <span className="text-github-text flex items-center space-x-1">
                <Folder className="w-4 h-4 text-github-accent" />
                <span>{part}</span>
              </span>
            ) : (
              <Link
                to={`/${owner}/${repo}/tree/${branch}/${pathParts.slice(0, index + 1).join('/')}`}
                className="text-github-accent hover:underline"
              >
                {part}
              </Link>
            )}
          </span>
        ))}
      </div>

      {/* File tree */}
      <FileTree
        items={tree}
        owner={owner}
        repo={repo}
        branch={branch}
        currentPath={path}
      />
    </div>
  );
}
