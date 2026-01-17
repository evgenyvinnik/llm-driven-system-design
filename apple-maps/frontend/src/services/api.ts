import type { LatLng, Place, Route, TrafficData, Incident, RoadSegment } from '../types';

const API_BASE = '/api';

class ApiService {
  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Route calculation
  async calculateRoute(
    origin: LatLng,
    destination: LatLng,
    options?: { avoidTolls?: boolean; avoidHighways?: boolean }
  ): Promise<Route> {
    const response = await this.fetch<{ success: boolean; route: Route }>('/routes', {
      method: 'POST',
      body: JSON.stringify({ origin, destination, options }),
    });
    return response.route;
  }

  async calculateRoutesWithAlternatives(
    origin: LatLng,
    destination: LatLng,
    options?: { avoidTolls?: boolean; avoidHighways?: boolean }
  ): Promise<Route[]> {
    const response = await this.fetch<{ success: boolean; routes: Route[] }>('/routes/alternatives', {
      method: 'POST',
      body: JSON.stringify({ origin, destination, options }),
    });
    return response.routes;
  }

  // Search
  async searchPlaces(
    query: string,
    options?: { lat?: number; lng?: number; radius?: number; category?: string; limit?: number }
  ): Promise<Place[]> {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (options?.lat) params.set('lat', options.lat.toString());
    if (options?.lng) params.set('lng', options.lng.toString());
    if (options?.radius) params.set('radius', options.radius.toString());
    if (options?.category) params.set('category', options.category);
    if (options?.limit) params.set('limit', options.limit.toString());

    const response = await this.fetch<{ success: boolean; results: Place[] }>(
      `/search?${params.toString()}`
    );
    return response.results;
  }

  async geocode(address: string): Promise<Array<{ formattedAddress: string; location: LatLng; placeId?: string; name?: string }>> {
    const response = await this.fetch<{ success: boolean; results: Array<{ formattedAddress: string; location: LatLng; placeId?: string; name?: string }> }>(
      `/search/geocode?address=${encodeURIComponent(address)}`
    );
    return response.results;
  }

  async reverseGeocode(lat: number, lng: number): Promise<{ type: string; name: string; address?: string } | null> {
    const response = await this.fetch<{ success: boolean; result: { type: string; name: string; address?: string } | null }>(
      `/search/reverse?lat=${lat}&lng=${lng}`
    );
    return response.result;
  }

  async getPlaceDetails(placeId: string): Promise<Place> {
    const response = await this.fetch<{ success: boolean; place: Place }>(
      `/search/places/${placeId}`
    );
    return response.place;
  }

  async getCategories(): Promise<Array<{ name: string; count: number }>> {
    const response = await this.fetch<{ success: boolean; categories: Array<{ name: string; count: number }> }>(
      '/search/categories'
    );
    return response.categories;
  }

  // Traffic
  async getTraffic(bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<TrafficData[]> {
    const params = new URLSearchParams({
      minLat: bounds.minLat.toString(),
      minLng: bounds.minLng.toString(),
      maxLat: bounds.maxLat.toString(),
      maxLng: bounds.maxLng.toString(),
    });

    const response = await this.fetch<{ success: boolean; traffic: TrafficData[] }>(
      `/traffic?${params.toString()}`
    );
    return response.traffic;
  }

  async getIncidents(bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<Incident[]> {
    const params = new URLSearchParams({
      minLat: bounds.minLat.toString(),
      minLng: bounds.minLng.toString(),
      maxLat: bounds.maxLat.toString(),
      maxLng: bounds.maxLng.toString(),
    });

    const response = await this.fetch<{ success: boolean; incidents: Incident[] }>(
      `/traffic/incidents?${params.toString()}`
    );
    return response.incidents;
  }

  async reportIncident(data: { lat: number; lng: number; type: string; severity?: string; description?: string }): Promise<Incident> {
    const response = await this.fetch<{ success: boolean; incident: Incident }>('/traffic/incidents', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return response.incident;
  }

  // Map data
  async getMapSegments(bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }): Promise<RoadSegment[]> {
    const params = new URLSearchParams({
      minLat: bounds.minLat.toString(),
      minLng: bounds.minLng.toString(),
      maxLat: bounds.maxLat.toString(),
      maxLng: bounds.maxLng.toString(),
    });

    const response = await this.fetch<{ success: boolean; segments: Array<{
      id: number;
      start_node_id: number;
      end_node_id: number;
      street_name: string;
      road_class: string;
      length_meters: number;
      free_flow_speed_kph: number;
      is_toll: boolean;
      is_one_way: boolean;
      start_lat: number;
      start_lng: number;
      end_lat: number;
      end_lng: number;
    }> }>(
      `/map/segments?${params.toString()}`
    );

    return response.segments.map(s => ({
      id: s.id,
      startNodeId: s.start_node_id,
      endNodeId: s.end_node_id,
      streetName: s.street_name,
      roadClass: s.road_class,
      length: s.length_meters,
      freeFlowSpeed: s.free_flow_speed_kph,
      isToll: s.is_toll,
      isOneWay: s.is_one_way,
      startLat: parseFloat(s.start_lat as unknown as string),
      startLng: parseFloat(s.start_lng as unknown as string),
      endLat: parseFloat(s.end_lat as unknown as string),
      endLng: parseFloat(s.end_lng as unknown as string),
    }));
  }

  async getPOIs(bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number }, category?: string): Promise<Place[]> {
    const params = new URLSearchParams({
      minLat: bounds.minLat.toString(),
      minLng: bounds.minLng.toString(),
      maxLat: bounds.maxLat.toString(),
      maxLng: bounds.maxLng.toString(),
    });
    if (category) params.set('category', category);

    const response = await this.fetch<{ success: boolean; pois: Array<{
      id: string;
      name: string;
      category: string;
      lat: number;
      lng: number;
      address: string;
      rating: number;
    }> }>(
      `/map/pois?${params.toString()}`
    );

    return response.pois.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      location: { lat: parseFloat(p.lat as unknown as string), lng: parseFloat(p.lng as unknown as string) },
      address: p.address,
      rating: p.rating ? parseFloat(p.rating as unknown as string) : undefined,
    }));
  }

  // Health check
  async healthCheck(): Promise<{ status: string; services: { database: string; redis: string } }> {
    return this.fetch('/health');
  }
}

export const api = new ApiService();
