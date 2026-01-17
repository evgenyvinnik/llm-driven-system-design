import { useEffect } from 'react';
import { useAppStore } from './stores/appStore';
import { Canvas } from './components/Canvas';
import { ColorPalette } from './components/ColorPalette';
import { CooldownTimer } from './components/CooldownTimer';
import { AuthPanel } from './components/AuthPanel';
import { Toolbar } from './components/Toolbar';

function App() {
  const { initialize, isLoading } = useAppStore();

  useEffect(() => {
    initialize();
  }, [initialize]);

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-gray-900">
        <div className="text-white text-xl">Loading r/place...</div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-900">
      {/* Header */}
      <header className="flex items-center justify-between p-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-3">
          <h1 className="text-white text-xl font-bold">r/place</h1>
          <Toolbar />
        </div>
        <AuthPanel />
      </header>

      {/* Main canvas area */}
      <main className="flex-1 relative overflow-hidden">
        <Canvas />
      </main>

      {/* Bottom toolbar */}
      <footer className="flex items-center justify-between p-3 bg-gray-800 border-t border-gray-700">
        <ColorPalette />
        <CooldownTimer />
      </footer>
    </div>
  );
}

export default App;
