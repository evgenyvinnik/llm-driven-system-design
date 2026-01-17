import { Link } from '@tanstack/react-router';
import { useAuthStore, useProjectStore, useUIStore } from '../stores';
import { Avatar, Button } from './ui';

export function Sidebar() {
  const { currentProject, projects } = useProjectStore();
  const { sidebarOpen, toggleSidebar } = useUIStore();

  if (!sidebarOpen) {
    return (
      <button
        onClick={toggleSidebar}
        className="fixed left-0 top-16 z-30 p-2 bg-white border-r border-b rounded-br shadow-sm hover:bg-gray-50"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    );
  }

  return (
    <aside className="w-64 bg-white border-r flex flex-col h-[calc(100vh-4rem)]">
      {/* Project selector */}
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-500">Project</span>
          <button onClick={toggleSidebar} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
        {currentProject ? (
          <Link
            to="/projects/$projectKey"
            params={{ projectKey: currentProject.key }}
            className="flex items-center gap-2 p-2 rounded hover:bg-gray-100"
          >
            <div className="w-8 h-8 bg-blue-500 text-white rounded flex items-center justify-center font-medium">
              {currentProject.key.slice(0, 2)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{currentProject.name}</div>
              <div className="text-sm text-gray-500">{currentProject.key}</div>
            </div>
          </Link>
        ) : (
          <div className="text-gray-500 text-sm">No project selected</div>
        )}
      </div>

      {/* Navigation */}
      {currentProject && (
        <nav className="flex-1 p-4 space-y-1">
          <NavItem to={`/projects/${currentProject.key}/board`} icon="board">
            Board
          </NavItem>
          <NavItem to={`/projects/${currentProject.key}/backlog`} icon="backlog">
            Backlog
          </NavItem>
          <NavItem to={`/projects/${currentProject.key}/issues`} icon="issues">
            Issues
          </NavItem>
          <NavItem to={`/projects/${currentProject.key}/settings`} icon="settings">
            Settings
          </NavItem>
        </nav>
      )}

      {/* Project list */}
      <div className="p-4 border-t">
        <div className="text-sm font-medium text-gray-500 mb-2">All Projects</div>
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectKey"
              params={{ projectKey: project.key }}
              className="flex items-center gap-2 p-2 rounded hover:bg-gray-100 text-sm"
            >
              <div className="w-6 h-6 bg-gray-400 text-white rounded flex items-center justify-center text-xs font-medium">
                {project.key.slice(0, 2)}
              </div>
              <span className="truncate">{project.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </aside>
  );
}

function NavItem({
  to,
  icon,
  children,
}: {
  to: string;
  icon: 'board' | 'backlog' | 'issues' | 'settings';
  children: React.ReactNode;
}) {
  const icons = {
    board: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2"
        />
      </svg>
    ),
    backlog: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
      </svg>
    ),
    issues: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
    ),
    settings: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  };

  return (
    <Link
      to={to}
      className="flex items-center gap-3 px-3 py-2 rounded text-gray-700 hover:bg-gray-100 transition-colors"
      activeProps={{ className: 'bg-blue-50 text-blue-700' }}
    >
      {icons[icon]}
      <span>{children}</span>
    </Link>
  );
}

export function Header() {
  const { user, logout } = useAuthStore();
  const { setSearchModalOpen, setCreateIssueModalOpen } = useUIStore();

  return (
    <header className="h-16 bg-white border-b flex items-center justify-between px-4 sticky top-0 z-40">
      <div className="flex items-center gap-4">
        <Link to="/" className="flex items-center gap-2">
          <svg className="w-8 h-8 text-blue-600" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
          <span className="text-xl font-bold text-gray-800">Jira Clone</span>
        </Link>
      </div>

      <div className="flex-1 max-w-xl mx-8">
        <button
          onClick={() => setSearchModalOpen(true)}
          className="w-full flex items-center gap-2 px-4 py-2 text-gray-500 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <span>Search issues...</span>
          <kbd className="ml-auto px-2 py-0.5 text-xs bg-gray-200 rounded">Ctrl+K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-4">
        <Button variant="primary" size="sm" onClick={() => setCreateIssueModalOpen(true)}>
          Create
        </Button>

        {user && (
          <div className="flex items-center gap-2">
            <Avatar user={user} />
            <button onClick={logout} className="text-gray-500 hover:text-gray-700">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                />
              </svg>
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
