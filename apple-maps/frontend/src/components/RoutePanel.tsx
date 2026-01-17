import { useMapStore } from '../stores/mapStore';

export default function RoutePanel() {
  const {
    origin,
    destination,
    route,
    isLoadingRoute,
    routeError,
    calculateRoute,
    clearRoute,
    setOrigin,
    setDestination,
    navigation,
    startNavigation,
    stopNavigation,
    routeOptions,
    setRouteOptions,
  } = useMapStore();

  const hasOriginAndDestination = origin && destination;

  const handleSwap = () => {
    const tempOrigin = origin;
    setOrigin(destination);
    setDestination(tempOrigin);
  };

  const handleClear = () => {
    setOrigin(null);
    setDestination(null);
    clearRoute();
  };

  const getManeuverIcon = (type: string): string => {
    switch (type) {
      case 'depart': return '🚗';
      case 'arrive': return '🏁';
      case 'left': return '⬅️';
      case 'right': return '➡️';
      case 'slight-left': return '↖️';
      case 'slight-right': return '↗️';
      case 'sharp-left': return '↩️';
      case 'sharp-right': return '↪️';
      case 'u-turn': return '🔄';
      case 'straight': return '⬆️';
      default: return '📍';
    }
  };

  if (!hasOriginAndDestination && !route) {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-4 py-3 text-center">
        <p className="text-apple-gray-500 text-sm">
          Click on the map to set origin and destination
        </p>
      </div>
    );
  }

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-white/95 backdrop-blur-sm rounded-t-3xl shadow-2xl max-h-[50vh] overflow-hidden flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-apple-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold text-lg text-apple-gray-600">
            {navigation.isNavigating ? 'Navigation' : 'Route'}
          </h2>
          <button
            onClick={handleClear}
            className="text-apple-gray-400 hover:text-apple-gray-600 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Origin/Destination inputs */}
        <div className="flex gap-2">
          <div className="flex-grow space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-apple-blue" />
              <div className="flex-grow bg-apple-gray-100 rounded-lg px-3 py-2 text-sm text-apple-gray-600 truncate">
                {origin ? `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}` : 'Set origin'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-apple-red" />
              <div className="flex-grow bg-apple-gray-100 rounded-lg px-3 py-2 text-sm text-apple-gray-600 truncate">
                {destination ? `${destination.lat.toFixed(4)}, ${destination.lng.toFixed(4)}` : 'Set destination'}
              </div>
            </div>
          </div>
          <button
            onClick={handleSwap}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-lg bg-apple-gray-100 hover:bg-apple-gray-200 transition-colors self-center"
          >
            <svg className="w-5 h-5 text-apple-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
            </svg>
          </button>
        </div>

        {/* Route options */}
        <div className="flex gap-4 mt-3">
          <label className="flex items-center gap-2 text-sm text-apple-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={routeOptions.avoidTolls}
              onChange={(e) => setRouteOptions({ avoidTolls: e.target.checked })}
              className="rounded border-apple-gray-300 text-apple-blue focus:ring-apple-blue"
            />
            Avoid tolls
          </label>
          <label className="flex items-center gap-2 text-sm text-apple-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={routeOptions.avoidHighways}
              onChange={(e) => setRouteOptions({ avoidHighways: e.target.checked })}
              className="rounded border-apple-gray-300 text-apple-blue focus:ring-apple-blue"
            />
            Avoid highways
          </label>
        </div>

        {/* Calculate button */}
        {!route && (
          <button
            onClick={calculateRoute}
            disabled={!hasOriginAndDestination || isLoadingRoute}
            className="w-full mt-3 bg-apple-blue text-white py-3 rounded-xl font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-600 transition-colors flex items-center justify-center gap-2"
          >
            {isLoadingRoute ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Calculating...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                </svg>
                Get Directions
              </>
            )}
          </button>
        )}

        {routeError && (
          <div className="mt-3 p-3 bg-apple-red/10 rounded-lg text-apple-red text-sm">
            {routeError}
          </div>
        )}
      </div>

      {/* Route info and maneuvers */}
      {route && (
        <>
          {/* Route summary */}
          <div className="p-4 bg-apple-gray-100 flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold text-apple-gray-600">{route.durationFormatted}</p>
              <p className="text-sm text-apple-gray-400">{route.distanceFormatted}</p>
            </div>
            <div className="flex gap-2">
              {navigation.isNavigating ? (
                <button
                  onClick={stopNavigation}
                  className="bg-apple-red text-white px-4 py-2 rounded-xl font-medium hover:bg-red-600 transition-colors"
                >
                  End
                </button>
              ) : (
                <button
                  onClick={startNavigation}
                  className="bg-apple-green text-white px-4 py-2 rounded-xl font-medium hover:bg-green-600 transition-colors flex items-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Start
                </button>
              )}
            </div>
          </div>

          {/* Navigation status */}
          {navigation.isNavigating && (
            <div className="p-4 bg-apple-blue text-white">
              <div className="flex items-center gap-4">
                <span className="text-4xl">
                  {getManeuverIcon(route.maneuvers[navigation.currentManeuverIndex]?.type || 'straight')}
                </span>
                <div>
                  <p className="text-lg font-semibold">
                    {route.maneuvers[navigation.currentManeuverIndex]?.instruction}
                  </p>
                  <p className="text-sm opacity-80">
                    in {Math.round(navigation.distanceToNextManeuver)} m
                  </p>
                </div>
              </div>
              {navigation.eta && (
                <p className="mt-2 text-sm opacity-80">
                  ETA: {navigation.eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>
          )}

          {/* Maneuvers list */}
          <div className="flex-1 overflow-y-auto">
            {route.maneuvers.map((maneuver, index) => (
              <div
                key={index}
                className={`flex items-start gap-3 p-4 border-b border-apple-gray-100 ${
                  navigation.isNavigating && index === navigation.currentManeuverIndex
                    ? 'bg-apple-blue/10'
                    : ''
                }`}
              >
                <span className="text-2xl flex-shrink-0">{getManeuverIcon(maneuver.type)}</span>
                <div className="flex-grow">
                  <p className="text-apple-gray-600 font-medium">{maneuver.instruction}</p>
                  {maneuver.streetName && (
                    <p className="text-sm text-apple-gray-400">{maneuver.streetName}</p>
                  )}
                </div>
                {maneuver.distanceFormatted && (
                  <span className="text-sm text-apple-gray-400 flex-shrink-0">
                    {maneuver.distanceFormatted}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
