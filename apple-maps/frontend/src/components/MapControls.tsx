import { useMapStore } from '../stores/mapStore';

export default function MapControls() {
  const {
    showTraffic,
    toggleTraffic,
    showPOIs,
    togglePOIs,
    showIncidents,
    toggleIncidents,
    setCenter,
    setZoom,
  } = useMapStore();

  const handleMyLocation = () => {
    if ('geolocation' in navigator) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          setCenter({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
          });
          setZoom(16);
        },
        (error) => {
          console.error('Geolocation error:', error);
          alert('Unable to get your location');
        }
      );
    } else {
      alert('Geolocation is not supported by your browser');
    }
  };

  return (
    <div className="absolute right-4 top-20 flex flex-col gap-2">
      {/* Layer toggles */}
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-1 flex flex-col">
        <button
          onClick={toggleTraffic}
          className={`p-2 rounded-lg transition-colors ${
            showTraffic ? 'bg-apple-blue text-white' : 'text-apple-gray-500 hover:bg-apple-gray-100'
          }`}
          title="Toggle traffic"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </button>

        <button
          onClick={togglePOIs}
          className={`p-2 rounded-lg transition-colors ${
            showPOIs ? 'bg-apple-green text-white' : 'text-apple-gray-500 hover:bg-apple-gray-100'
          }`}
          title="Toggle POIs"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        <button
          onClick={toggleIncidents}
          className={`p-2 rounded-lg transition-colors ${
            showIncidents ? 'bg-apple-orange text-white' : 'text-apple-gray-500 hover:bg-apple-gray-100'
          }`}
          title="Toggle incidents"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </button>
      </div>

      {/* Location button */}
      <button
        onClick={handleMyLocation}
        className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-3 text-apple-gray-500 hover:text-apple-blue hover:bg-apple-gray-100 transition-colors"
        title="My location"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0013 3.06V1h-2v2.06A8.994 8.994 0 003.06 11H1v2h2.06A8.994 8.994 0 0011 20.94V23h2v-2.06A8.994 8.994 0 0020.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z" />
        </svg>
      </button>

      {/* Zoom controls */}
      <div className="bg-white/95 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden flex flex-col">
        <button
          onClick={() => setZoom(useMapStore.getState().zoom + 1)}
          className="p-3 text-apple-gray-500 hover:bg-apple-gray-100 transition-colors border-b border-apple-gray-100"
          title="Zoom in"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </button>
        <button
          onClick={() => setZoom(useMapStore.getState().zoom - 1)}
          className="p-3 text-apple-gray-500 hover:bg-apple-gray-100 transition-colors"
          title="Zoom out"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
