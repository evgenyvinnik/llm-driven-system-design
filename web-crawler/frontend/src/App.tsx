import { Outlet } from '@tanstack/react-router';
import { Header } from './components/Header';

export function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto">
        <Outlet />
      </main>
    </div>
  );
}
