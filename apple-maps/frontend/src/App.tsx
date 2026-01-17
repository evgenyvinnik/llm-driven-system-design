import MapView from './components/MapView';
import SearchBar from './components/SearchBar';
import RoutePanel from './components/RoutePanel';
import MapControls from './components/MapControls';

export default function App() {
  return (
    <div className="h-screen w-screen relative overflow-hidden">
      {/* Map */}
      <MapView />

      {/* Search bar */}
      <div className="absolute top-4 left-4 right-4 z-10 flex justify-center">
        <SearchBar />
      </div>

      {/* Map controls */}
      <MapControls />

      {/* Route panel */}
      <RoutePanel />
    </div>
  );
}
