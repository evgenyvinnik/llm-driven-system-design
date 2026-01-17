import { useState, useEffect, useCallback } from 'react';
import { driverAPI } from '../services/api';

interface GeolocationState {
  lat: number | null;
  lon: number | null;
  error: string | null;
  isTracking: boolean;
}

export function useDriverLocation(autoTrack = false, intervalMs = 10000) {
  const [state, setState] = useState<GeolocationState>({
    lat: null,
    lon: null,
    error: null,
    isTracking: false,
  });

  const updateLocation = useCallback(async () => {
    if (!navigator.geolocation) {
      setState((s) => ({ ...s, error: 'Geolocation not supported' }));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        setState((s) => ({ ...s, lat: latitude, lon: longitude, error: null }));

        // Send to server
        try {
          await driverAPI.updateLocation(latitude, longitude);
        } catch (err) {
          console.error('Failed to update location:', err);
        }
      },
      (error) => {
        setState((s) => ({ ...s, error: error.message }));
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0,
      }
    );
  }, []);

  const startTracking = useCallback(() => {
    setState((s) => ({ ...s, isTracking: true }));
    updateLocation();
  }, [updateLocation]);

  const stopTracking = useCallback(() => {
    setState((s) => ({ ...s, isTracking: false }));
  }, []);

  useEffect(() => {
    if (autoTrack) {
      startTracking();
    }
  }, [autoTrack, startTracking]);

  useEffect(() => {
    if (!state.isTracking) return;

    const interval = setInterval(updateLocation, intervalMs);
    return () => clearInterval(interval);
  }, [state.isTracking, updateLocation, intervalMs]);

  return {
    ...state,
    startTracking,
    stopTracking,
    updateLocation,
  };
}
