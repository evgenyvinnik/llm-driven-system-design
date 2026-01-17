import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import { CodeViewer } from '../components/CodeViewer';
import { ChevronRight, FileText } from 'lucide-react';

export const Route = createFileRoute('/$owner/$repo/blob/$branch/$')({
  component: BlobPage,
});

function BlobPage() {
  const { owner, repo, branch } = useParams({ from: '/$owner/$repo/blob/$branch/$' });
  const path = Route.useParams()['_splat'] || '';
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchFile() {
      setLoading(true);
      try {
        const data = await api.getFileContent(owner, repo, branch, path);
        setContent(data.content);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetchFile();
  }, [owner, repo, branch, path]);

  const filename = path.split('/').pop() || '';
  const pathParts = path.split('/');

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="text-github-muted">Loading file...</div>
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
                <FileText className="w-4 h-4" />
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

      {/* File content */}
      {content !== null && <CodeViewer content={content} filename={filename} />}
    </div>
  );
}
