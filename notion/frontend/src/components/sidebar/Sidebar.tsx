import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore, useWorkspaceStore, usePageStore } from '@/stores';
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Settings,
  LogOut,
  File,
  Database,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { Page } from '@/types';

export default function Sidebar() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const { workspaces, currentWorkspace, setCurrentWorkspace } = useWorkspaceStore();
  const { pages, expandedPages, toggleExpanded, createPage, deletePage, currentPage } = usePageStore();
  const [showWorkspaceMenu, setShowWorkspaceMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/login' });
  };

  const handleCreatePage = async (parentId?: string) => {
    if (!currentWorkspace) return;

    const page = await createPage({
      workspace_id: currentWorkspace.id,
      parent_id: parentId,
      title: '',
    });

    navigate({ to: '/page/$pageId', params: { pageId: page.id } });
  };

  const handleCreateDatabase = async () => {
    if (!currentWorkspace) return;

    const page = await createPage({
      workspace_id: currentWorkspace.id,
      title: 'New Database',
      icon: '📊',
      is_database: true,
    });

    navigate({ to: '/page/$pageId', params: { pageId: page.id } });
  };

  const handleDeletePage = async (pageId: string) => {
    await deletePage(pageId);
    setContextMenu(null);
    if (currentPage?.id === pageId) {
      navigate({ to: '/' });
    }
  };

  const handleContextMenu = (e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    setContextMenu({ pageId, x: e.clientX, y: e.clientY });
  };

  // Build page tree
  const rootPages = pages.filter((p) => !p.parent_id);

  const renderPageItem = (page: Page, level = 0) => {
    const children = pages.filter((p) => p.parent_id === page.id);
    const hasChildren = children.length > 0;
    const isExpanded = expandedPages.has(page.id);
    const isActive = currentPage?.id === page.id;

    return (
      <div key={page.id}>
        <div
          className={`sidebar-item group ${isActive ? 'active' : ''}`}
          style={{ paddingLeft: `${8 + level * 16}px` }}
          onContextMenu={(e) => handleContextMenu(e, page.id)}
        >
          {/* Expand/Collapse button */}
          <button
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) {
                toggleExpanded(page.id);
              }
            }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown className="w-4 h-4 text-notion-text-secondary" />
              ) : (
                <ChevronRight className="w-4 h-4 text-notion-text-secondary" />
              )
            ) : null}
          </button>

          {/* Page link */}
          <Link
            to="/page/$pageId"
            params={{ pageId: page.id }}
            className="flex-1 flex items-center gap-2 truncate"
          >
            <span className="text-sm">
              {page.icon || (page.is_database ? '📊' : '📄')}
            </span>
            <span className="truncate text-sm">
              {page.title || 'Untitled'}
            </span>
          </Link>

          {/* Actions */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
              onClick={(e) => {
                e.stopPropagation();
                handleContextMenu(e, page.id);
              }}
            >
              <MoreHorizontal className="w-3 h-3" />
            </button>
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
              onClick={(e) => {
                e.stopPropagation();
                handleCreatePage(page.id);
              }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Children */}
        {hasChildren && isExpanded && (
          <div>
            {children.map((child) => renderPageItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="sidebar w-60 border-r border-notion-border">
      {/* Workspace selector */}
      <div className="p-2 border-b border-notion-border">
        <button
          className="w-full sidebar-item font-medium"
          onClick={() => setShowWorkspaceMenu(!showWorkspaceMenu)}
        >
          <span className="text-lg">{currentWorkspace?.icon || '📁'}</span>
          <span className="flex-1 text-left truncate">
            {currentWorkspace?.name || 'Select Workspace'}
          </span>
          <ChevronDown className="w-4 h-4 text-notion-text-secondary" />
        </button>

        {showWorkspaceMenu && (
          <div className="mt-1 bg-white border border-notion-border rounded-md shadow-lg">
            {workspaces.map((ws) => (
              <button
                key={ws.id}
                className="w-full sidebar-item"
                onClick={() => {
                  setCurrentWorkspace(ws);
                  setShowWorkspaceMenu(false);
                }}
              >
                <span>{ws.icon || '📁'}</span>
                <span className="truncate">{ws.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="p-2 border-b border-notion-border">
        <button className="w-full sidebar-item text-notion-text-secondary">
          <Search className="w-4 h-4" />
          <span className="text-sm">Search</span>
        </button>
        <button className="w-full sidebar-item text-notion-text-secondary">
          <Settings className="w-4 h-4" />
          <span className="text-sm">Settings</span>
        </button>
      </div>

      {/* Pages list */}
      <div className="flex-1 overflow-auto p-2">
        <div className="flex items-center justify-between mb-2 px-2">
          <span className="text-xs font-medium text-notion-text-secondary uppercase">
            Pages
          </span>
          <div className="flex gap-1">
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-hover"
              onClick={() => handleCreatePage()}
              title="New page"
            >
              <Plus className="w-4 h-4 text-notion-text-secondary" />
            </button>
          </div>
        </div>

        {rootPages.map((page) => renderPageItem(page))}

        {/* Add database button */}
        <button
          className="w-full sidebar-item mt-2 text-notion-text-secondary"
          onClick={handleCreateDatabase}
        >
          <Database className="w-4 h-4" />
          <span className="text-sm">New database</span>
        </button>
      </div>

      {/* User section */}
      <div className="p-2 border-t border-notion-border">
        <div className="sidebar-item">
          <div className="w-6 h-6 rounded bg-notion-accent text-white flex items-center justify-center text-xs font-medium">
            {user?.name?.charAt(0).toUpperCase() || 'U'}
          </div>
          <span className="flex-1 truncate text-sm">{user?.name || 'User'}</span>
          <button
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-notion-border"
            onClick={handleLogout}
            title="Log out"
          >
            <LogOut className="w-4 h-4 text-notion-text-secondary" />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 bg-white border border-notion-border rounded-md shadow-lg py-1 min-w-40"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm"
              onClick={() => {
                handleCreatePage(contextMenu.pageId);
                setContextMenu(null);
              }}
            >
              <Plus className="w-4 h-4" />
              Add subpage
            </button>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm text-red-600"
              onClick={() => handleDeletePage(contextMenu.pageId)}
            >
              <Trash2 className="w-4 h-4" />
              Delete
            </button>
          </div>
        </>
      )}
    </aside>
  );
}
