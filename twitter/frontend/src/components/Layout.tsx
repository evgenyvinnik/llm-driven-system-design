import { Outlet } from '@tanstack/react-router';
import { Sidebar } from './Sidebar';
import { TrendingSidebar } from './TrendingSidebar';
import { WhoToFollow } from './WhoToFollow';

/** Renders the three-column Twitter layout with sidebar, main feed, and trending panel. */
export function Layout() {
  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-[1280px] mx-auto flex">
        <Sidebar />

        <main className="flex-1 border-x border-twitter-border min-h-screen max-w-[600px]">
          <Outlet />
        </main>

        <aside className="w-[350px] pl-8 pr-4 hidden lg:block">
          <div className="sticky top-4 space-y-4">
            {/* Search bar */}
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <svg className="w-5 h-5 text-twitter-gray" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                placeholder="Search Twitter"
                className="w-full bg-twitter-background rounded-full py-3 pl-12 pr-4 text-[15px] placeholder-twitter-gray focus:outline-none focus:ring-2 focus:ring-twitter-blue focus:bg-white border border-transparent focus:border-twitter-blue transition-all"
              />
            </div>

            <TrendingSidebar />

            <WhoToFollow />

            {/* Footer links */}
            <div className="px-4 text-[13px] text-twitter-gray">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                <a href="#" className="hover:underline">Terms of Service</a>
                <a href="#" className="hover:underline">Privacy Policy</a>
                <a href="#" className="hover:underline">Cookie Policy</a>
                <a href="#" className="hover:underline">Accessibility</a>
                <a href="#" className="hover:underline">Ads info</a>
                <a href="#" className="hover:underline">More</a>
              </div>
              <p className="mt-2">2024 Twitter Clone</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
