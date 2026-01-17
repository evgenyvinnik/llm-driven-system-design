import { Outlet } from '@tanstack/react-router';
import { Sidebar } from './Sidebar';
import { TrendingSidebar } from './TrendingSidebar';

export function Layout() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-7xl mx-auto flex">
        <Sidebar />

        <main className="flex-1 border-x border-twitter-extraLightGray min-h-screen max-w-[600px]">
          <Outlet />
        </main>

        <aside className="w-80 p-4 hidden lg:block">
          <div className="sticky top-4 space-y-4">
            <TrendingSidebar />
          </div>
        </aside>
      </div>
    </div>
  );
}
