const API_BASE = '/api';

async function fetchAPI<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth
export const authAPI = {
  register: (data: { email: string; password: string; name: string }) =>
    fetchAPI('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: { email: string; password: string }) =>
    fetchAPI('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => fetchAPI('/auth/logout', { method: 'POST' }),

  getMe: () => fetchAPI<{ user: import('../types').User }>('/auth/me'),

  becomeHost: () => fetchAPI('/auth/become-host', { method: 'POST' }),

  updateProfile: (data: Partial<import('../types').User>) =>
    fetchAPI('/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
};

// Listings
export const listingsAPI = {
  getAll: (params?: Record<string, string | number>) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        searchParams.set(key, String(value));
      });
    }
    return fetchAPI<{ listings: import('../types').Listing[] }>(
      `/listings?${searchParams.toString()}`
    );
  },

  getById: (id: number) =>
    fetchAPI<{ listing: import('../types').Listing }>(`/listings/${id}`),

  create: (data: Partial<import('../types').Listing>) =>
    fetchAPI<{ listing: import('../types').Listing }>('/listings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<import('../types').Listing>) =>
    fetchAPI<{ listing: import('../types').Listing }>(`/listings/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) => fetchAPI(`/listings/${id}`, { method: 'DELETE' }),

  getMyListings: () =>
    fetchAPI<{ listings: import('../types').Listing[] }>('/listings/host/my-listings'),

  getAvailability: (id: number, startDate: string, endDate: string) =>
    fetchAPI<{ availability: import('../types').AvailabilityBlock[] }>(
      `/listings/${id}/availability?start_date=${startDate}&end_date=${endDate}`
    ),

  updateAvailability: (
    id: number,
    data: { start_date: string; end_date: string; status: string; price_per_night?: number }
  ) =>
    fetchAPI(`/listings/${id}/availability`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  uploadPhotos: async (id: number, files: FileList) => {
    const formData = new FormData();
    Array.from(files).forEach((file) => formData.append('photos', file));
    const response = await fetch(`${API_BASE}/listings/${id}/photos`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    if (!response.ok) throw new Error('Upload failed');
    return response.json();
  },

  deletePhoto: (listingId: number, photoId: number) =>
    fetchAPI(`/listings/${listingId}/photos/${photoId}`, { method: 'DELETE' }),
};

// Search
export const searchAPI = {
  search: (params: import('../types').SearchParams) => {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          value.forEach((v) => searchParams.append(key, v));
        } else {
          searchParams.set(key, String(value));
        }
      }
    });
    return fetchAPI<{ listings: import('../types').Listing[]; total: number }>(
      `/search?${searchParams.toString()}`
    );
  },

  suggest: (q: string) =>
    fetchAPI<{
      suggestions: Array<{
        label: string;
        city: string;
        state: string;
        country: string;
        latitude: number;
        longitude: number;
      }>;
    }>(`/search/suggest?q=${encodeURIComponent(q)}`),

  getPopularDestinations: () =>
    fetchAPI<{
      destinations: Array<{
        city: string;
        state: string;
        country: string;
        listing_count: number;
        latitude: number;
        longitude: number;
      }>;
    }>('/search/popular-destinations'),
};

// Bookings
export const bookingsAPI = {
  checkAvailability: (
    listingId: number,
    checkIn: string,
    checkOut: string
  ) =>
    fetchAPI<{
      available: boolean;
      pricing: import('../types').PricingDetails | null;
      instant_book: boolean;
      minimum_nights: number;
      maximum_nights: number;
    }>(
      `/bookings/check-availability?listing_id=${listingId}&check_in=${checkIn}&check_out=${checkOut}`
    ),

  create: (data: {
    listing_id: number;
    check_in: string;
    check_out: string;
    guests: number;
    message?: string;
  }) =>
    fetchAPI<{ booking: import('../types').Booking }>('/bookings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getMyTrips: (status?: string) =>
    fetchAPI<{ bookings: import('../types').Booking[] }>(
      `/bookings/my-trips${status ? `?status=${status}` : ''}`
    ),

  getHostReservations: (status?: string) =>
    fetchAPI<{ bookings: import('../types').Booking[] }>(
      `/bookings/host-reservations${status ? `?status=${status}` : ''}`
    ),

  getById: (id: number) =>
    fetchAPI<{ booking: import('../types').Booking }>(`/bookings/${id}`),

  respond: (id: number, action: 'confirm' | 'decline', message?: string) =>
    fetchAPI(`/bookings/${id}/respond`, {
      method: 'PUT',
      body: JSON.stringify({ action, message }),
    }),

  cancel: (id: number) =>
    fetchAPI(`/bookings/${id}/cancel`, { method: 'PUT' }),

  complete: (id: number) =>
    fetchAPI(`/bookings/${id}/complete`, { method: 'PUT' }),
};

// Reviews
export const reviewsAPI = {
  create: (data: {
    booking_id: number;
    rating: number;
    cleanliness_rating?: number;
    communication_rating?: number;
    location_rating?: number;
    value_rating?: number;
    content?: string;
  }) =>
    fetchAPI<{ review: import('../types').Review }>('/reviews', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getForListing: (listingId: number) =>
    fetchAPI<{
      reviews: import('../types').Review[];
      stats: {
        total: number;
        avg_rating: number;
        avg_cleanliness: number;
        avg_communication: number;
        avg_location: number;
        avg_value: number;
      };
    }>(`/reviews/listing/${listingId}`),

  getForUser: (userId: number, type?: 'as_host' | 'as_guest') =>
    fetchAPI<{ reviews: import('../types').Review[] }>(
      `/reviews/user/${userId}${type ? `?type=${type}` : ''}`
    ),

  getBookingStatus: (bookingId: number) =>
    fetchAPI<{
      host_reviewed: boolean;
      guest_reviewed: boolean;
      visible: boolean;
      can_review: boolean;
    }>(`/reviews/booking/${bookingId}/status`),
};

// Messages
export const messagesAPI = {
  startConversation: (listingId: number, bookingId?: number) =>
    fetchAPI<{ conversation: import('../types').Conversation }>('/messages/start', {
      method: 'POST',
      body: JSON.stringify({ listing_id: listingId, booking_id: bookingId }),
    }),

  getConversations: () =>
    fetchAPI<{ conversations: import('../types').Conversation[] }>('/messages'),

  getConversation: (id: number) =>
    fetchAPI<{
      conversation: import('../types').Conversation;
      messages: import('../types').Message[];
    }>(`/messages/${id}`),

  sendMessage: (conversationId: number, content: string) =>
    fetchAPI<{ message: import('../types').Message }>(`/messages/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  getUnreadCount: () => fetchAPI<{ count: number }>('/messages/unread/count'),
};
