import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useWikiStore } from '../stores/wikiStore';
import { useAuthStore } from '../stores/authStore';
import SpaceSidebar from '../components/SpaceSidebar';
import PageEditor from '../components/PageEditor';
import * as api from '../services/api';

export const Route = createFileRoute('/space/$spaceKey/page/$slug/edit')({
  component: PageEditView,
});

function PageEditView() {
  const { spaceKey, slug } = Route.useParams();
  const { currentSpace, currentPage, pageTree, loadSpace, loadPageTree, loadPage } = useWikiStore();
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [contentHtml, setContentHtml] = useState('');
  const [changeMessage, setChangeMessage] = useState('');

  useEffect(() => {
    loadSpace(spaceKey);
    loadPageTree(spaceKey);
  }, [spaceKey, loadSpace, loadPageTree]);

  useEffect(() => {
    if (slug === 'new') {
      setTitle('');
      setContentHtml('');
    } else {
      loadPage(spaceKey, slug);
    }
  }, [spaceKey, slug, loadPage]);

  useEffect(() => {
    if (currentPage && slug !== 'new') {
      setTitle(currentPage.title);
      setContentHtml(currentPage.content_html);
    }
  }, [currentPage, slug]);

  if (!user) {
    navigate({ to: '/login' });
    return null;
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      // Strip HTML to get plain text
      const tmp = document.createElement('div');
      tmp.innerHTML = contentHtml;
      const contentText = tmp.textContent || tmp.innerText || '';

      if (slug === 'new') {
        if (!currentSpace) return;
        const { page } = await api.createPage({
          spaceId: currentSpace.id,
          title,
          contentHtml,
          contentText,
          contentJson: {},
        });
        navigate({
          to: '/space/$spaceKey/page/$slug',
          params: { spaceKey, slug: page.slug },
        });
      } else {
        if (!currentPage) return;
        const { page } = await api.updatePage(currentPage.id, {
          title,
          contentHtml,
          contentText,
          contentJson: {},
          changeMessage: changeMessage || undefined,
          version: currentPage.version,
        });
        // A rename changes the slug; the old one no longer resolves.
        navigate({
          to: '/space/$spaceKey/page/$slug',
          params: { spaceKey, slug: page.slug },
        });
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save page');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (slug === 'new') {
      navigate({ to: '/space/$spaceKey', params: { spaceKey } });
    } else {
      navigate({
        to: '/space/$spaceKey/page/$slug',
        params: { spaceKey, slug },
      });
    }
  };

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {currentSpace && (
        <SpaceSidebar space={currentSpace} tree={pageTree} spaceKey={spaceKey} />
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6">
          {/* Editor Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-lg font-semibold text-confluence-text">
              {slug === 'new' ? 'Create Page' : 'Edit Page'}
            </h2>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={changeMessage}
                onChange={(e) => setChangeMessage(e.target.value)}
                placeholder="Change description (optional)"
                className="px-3 py-1.5 text-sm border border-confluence-border rounded focus:outline-none focus:ring-2 focus:ring-confluence-primary"
              />
              <button
                onClick={handleCancel}
                className="px-4 py-1.5 text-sm text-confluence-text-subtle border border-confluence-border rounded hover:bg-confluence-sidebar transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !title.trim()}
                className="px-4 py-1.5 text-sm bg-confluence-primary text-white rounded hover:bg-confluence-hover disabled:opacity-50 transition-colors"
              >
                {saving ? 'Saving...' : 'Publish'}
              </button>
            </div>
          </div>

          {/* Title input */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Page title"
            className="w-full text-3xl font-bold text-confluence-text border-none outline-none mb-4 placeholder-confluence-text-muted"
          />

          {/* Editor */}
          <PageEditor
            initialContent={contentHtml}
            onChange={setContentHtml}
          />
        </div>
      </div>
    </div>
  );
}
