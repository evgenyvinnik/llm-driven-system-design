interface RecentPage {
  url: string;
  domain: string;
  title: string;
  statusCode: number;
  crawledAt: string;
  durationMs: number;
}

interface RecentPagesTableProps {
  pages: RecentPage[];
  loading?: boolean;
}

export function RecentPagesTable({ pages, loading }: RecentPagesTableProps) {
  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="animate-pulse space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-100 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200">
        <h3 className="text-sm font-medium text-gray-900">Recently Crawled Pages</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                URL
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Domain
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Duration
              </th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                Time
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {pages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  No pages crawled yet
                </td>
              </tr>
            ) : (
              pages.map((page, index) => (
                <tr key={index} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <div className="max-w-xs truncate">
                      <a
                        href={page.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary-600 hover:text-primary-800"
                        title={page.url}
                      >
                        {page.title || page.url}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600">{page.domain}</td>
                  <td className="px-4 py-2">
                    <StatusBadge code={page.statusCode} />
                  </td>
                  <td className="px-4 py-2 text-sm text-gray-600">{page.durationMs}ms</td>
                  <td className="px-4 py-2 text-sm text-gray-500">
                    {formatTimeAgo(page.crawledAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ code }: { code: number }) {
  const color =
    code >= 200 && code < 300
      ? 'bg-green-100 text-green-800'
      : code >= 300 && code < 400
        ? 'bg-yellow-100 text-yellow-800'
        : code >= 400
          ? 'bg-red-100 text-red-800'
          : 'bg-gray-100 text-gray-800';

  return (
    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${color}`}>
      {code || 'N/A'}
    </span>
  );
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
