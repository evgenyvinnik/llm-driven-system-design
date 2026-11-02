import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useWikiStore } from '../stores/wikiStore';
import { useAuthStore } from '../stores/authStore';
import SpaceSidebar from '../components/SpaceSidebar';
import PageViewer from '../components/PageViewer';
import CommentSection from '../components/CommentSection';
import VersionList from '../components/VersionList';
import VersionDiff from '../components/VersionDiff';
import BreadcrumbNav from '../components/BreadcrumbNav';
import ApprovalBanner from '../components/ApprovalBanner';
import MacroRenderer from '../components/MacroRenderer';
import { formatFullDate } from '../utils/format';

export const Route = createFileRoute('/space/$spaceKey/page/$slug/')({
  component: PageView,
});

function PageView() {
  const { spaceKey, slug } = Route.useParams();
  const { currentSpace, currentPage, pageTree, loadSpace, loadPageTree, loadPage } = useWikiStore();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'view' | 'versions' | 'diff'>('view');

  useEffect(() => {
    loadSpace(spaceKey);
    loadPageTree(spaceKey);
  }, [spaceKey, loadSpace, loadPageTree]);

  useEffect(() => {
    loadPage(spaceKey, slug);
    setActiveTab('view');
  }, [spaceKey, slug, loadPage]);

  if (!currentPage) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-56px)]">
        <div className="text-confluence-text-subtle">Loading page...</div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {currentSpace && (
        <SpaceSidebar space={currentSpace} tree={pageTree} spaceKey={spaceKey} />
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6">
          {/* Breadcrumbs */}
          {currentPage.breadcrumbs && (
            <BreadcrumbNav
              breadcrumbs={currentPage.breadcrumbs}
              spaceKey={spaceKey}
              spaceName={currentSpace?.name || spaceKey}
            />
          )}

          {/* Approval Banner */}
          {currentPage.status !== 'published' && (
            <span className="inline-block mb-3 text-xs font-medium uppercase tracking-wide text-yellow-800 bg-yellow-100 px-2 py-0.5 rounded" data-testid="draft-badge">
              {currentPage.status} — visible to space members only
            </span>
          )}
          <ApprovalBanner pageId={currentPage.id} canEdit={Boolean(currentPage.access?.canEdit)} />

          {/* Page Header */}
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-confluence-text mb-2">
              {currentPage.title}
            </h1>
            <div className="flex items-center gap-4 text-sm text-confluence-text-subtle">
              <span>
                By {currentPage.author?.display_name || currentPage.author?.username || 'unknown'}
              </span>
              <span>
                Last updated: {formatFullDate(currentPage.updated_at)}
              </span>
              <span>
                v{currentPage.version}
              </span>
              {currentPage.status === 'draft' && (
                <span className="px-2 py-0.5 bg-yellow-100 text-yellow-800 rounded text-xs font-medium">
                  DRAFT
                </span>
              )}
            </div>

            {/* Labels */}
            {currentPage.labels && currentPage.labels.length > 0 && (
              <div className="flex gap-1 mt-3">
                {currentPage.labels.map((label) => (
                  <span
                    key={label}
                    className="text-xs bg-confluence-sidebar text-confluence-text-subtle px-2 py-1 rounded border border-confluence-border"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-confluence-border mb-6">
            <button
              onClick={() => setActiveTab('view')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'view'
                  ? 'text-confluence-primary border-confluence-primary'
                  : 'text-confluence-text-subtle border-transparent hover:text-confluence-text'
              }`}
            >
              Content
            </button>
            <button
              onClick={() => setActiveTab('versions')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'versions'
                  ? 'text-confluence-primary border-confluence-primary'
                  : 'text-confluence-text-subtle border-transparent hover:text-confluence-text'
              }`}
            >
              Version History
            </button>
            <button
              onClick={() => setActiveTab('diff')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'diff'
                  ? 'text-confluence-primary border-confluence-primary'
                  : 'text-confluence-text-subtle border-transparent hover:text-confluence-text'
              }`}
            >
              Diff
            </button>

            {/* Edit button (members and admins of the space) */}
            {user && currentPage.access?.canEdit && (
              <div className="ml-auto flex items-center">
                <Link
                  to="/space/$spaceKey/page/$slug/edit"
                  params={{ spaceKey, slug }}
                  className="px-4 py-1.5 bg-confluence-primary text-white text-sm rounded hover:bg-confluence-hover transition-colors"
                >
                  Edit
                </Link>
              </div>
            )}
          </div>

          {/* Tab Content */}
          {activeTab === 'view' && (
            <>
              {/* Macro content (if any macros in content_json) */}
              <MacroRenderer contentJson={currentPage.content_json as { macros?: Array<{ type: string; content?: string }> }} />

              <PageViewer html={currentPage.content_html} />

              <div className="mt-8 border-t border-confluence-border pt-6">
                <CommentSection pageId={currentPage.id} />
              </div>
            </>
          )}

          {activeTab === 'versions' && (
            <VersionList pageId={currentPage.id} currentVersion={currentPage.version} />
          )}

          {activeTab === 'diff' && (
            <VersionDiff pageId={currentPage.id} currentVersion={currentPage.version} />
          )}
        </div>
      </div>
    </div>
  );
}
