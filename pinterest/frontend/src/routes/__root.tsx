import { createRootRoute, Outlet } from '@tanstack/react-router';
import Header from '../components/Header';

// `createRootRoute`, not `createFileRoute('__root')`. The generated route tree
// uses this export as the tree's root and hangs every other route off it as a
// child — but `createFileRoute` produces an ordinary path route, which cannot
// parent anything. The visible symptom was that the layout rendered (header,
// search bar) and then *every* route below it resolved to "Not Found",
// including /login, so the app was unusable and unscreenshottable.
export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-white">
      <Header />
      <main className="pt-[64px]">
        <Outlet />
      </main>
    </div>
  );
}
