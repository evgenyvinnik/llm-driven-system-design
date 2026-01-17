import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Sidebar } from '../components/Sidebar';
import { Header } from '../components/Header';
import { Player } from '../components/Player';
import { AudioProvider } from '../components/AudioProvider';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <AudioProvider>
      <div className="h-screen flex flex-col bg-spotify-black">
        <div className="flex-1 flex overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-gradient-to-b from-spotify-light-gray to-spotify-black">
            <Header />
            <div className="p-6">
              <Outlet />
            </div>
          </main>
        </div>
        <Player />
      </div>
    </AudioProvider>
  );
}
