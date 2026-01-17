import { create } from 'zustand';
import type { Seat, Reservation, QueueStatus } from '../types';
import { seatsApi, queueApi, checkoutApi } from '../services/api';

interface TicketState {
  selectedSeats: Seat[];
  reservation: Reservation | null;
  queueStatus: QueueStatus | null;
  isLoading: boolean;
  error: string | null;
  checkoutTimer: number | null;

  // Seat selection
  selectSeat: (seat: Seat) => void;
  deselectSeat: (seatId: string) => void;
  clearSelection: () => void;

  // Reservation
  reserveSeats: (eventId: string) => Promise<void>;
  releaseSeats: (eventId: string) => Promise<void>;
  loadReservation: () => Promise<void>;

  // Queue
  joinQueue: (eventId: string) => Promise<void>;
  checkQueueStatus: (eventId: string) => Promise<void>;
  leaveQueue: (eventId: string) => Promise<void>;

  // Checkout
  checkout: (paymentMethod: string) => Promise<{ orderId: string }>;

  // Timer
  startCheckoutTimer: (expiresAt: string) => void;
  stopCheckoutTimer: () => void;

  clearError: () => void;
}

let timerInterval: NodeJS.Timeout | null = null;

export const useTicketStore = create<TicketState>((set, get) => ({
  selectedSeats: [],
  reservation: null,
  queueStatus: null,
  isLoading: false,
  error: null,
  checkoutTimer: null,

  selectSeat: (seat) => {
    const { selectedSeats } = get();
    if (selectedSeats.length >= 10) {
      set({ error: 'Maximum 10 seats per order' });
      return;
    }
    if (!selectedSeats.find((s) => s.id === seat.id)) {
      set({ selectedSeats: [...selectedSeats, seat], error: null });
    }
  },

  deselectSeat: (seatId) => {
    set({ selectedSeats: get().selectedSeats.filter((s) => s.id !== seatId) });
  },

  clearSelection: () => {
    set({ selectedSeats: [], reservation: null });
    get().stopCheckoutTimer();
  },

  reserveSeats: async (eventId) => {
    const { selectedSeats } = get();
    if (selectedSeats.length === 0) {
      set({ error: 'No seats selected' });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const response = await seatsApi.reserve(eventId, selectedSeats.map((s) => s.id));
      if (response.data) {
        const reservation: Reservation = {
          event_id: eventId,
          seats: response.data.seats,
          total_price: response.data.totalPrice,
          expires_at: response.data.expiresAt,
        };
        set({ reservation, isLoading: false });
        get().startCheckoutTimer(response.data.expiresAt);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to reserve seats', isLoading: false });
      throw error;
    }
  },

  releaseSeats: async (eventId) => {
    const { selectedSeats } = get();
    if (selectedSeats.length === 0) return;

    try {
      await seatsApi.release(eventId, selectedSeats.map((s) => s.id));
    } catch {
      // Ignore release errors
    }
    get().clearSelection();
  },

  loadReservation: async () => {
    try {
      const response = await seatsApi.getReservation();
      if (response.data) {
        set({ reservation: response.data });
        get().startCheckoutTimer(response.data.expires_at);
      }
    } catch {
      // No active reservation
    }
  },

  joinQueue: async (eventId) => {
    set({ isLoading: true, error: null });
    try {
      const response = await queueApi.join(eventId);
      if (response.data) {
        set({ queueStatus: response.data, isLoading: false });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to join queue', isLoading: false });
      throw error;
    }
  },

  checkQueueStatus: async (eventId) => {
    try {
      const response = await queueApi.getStatus(eventId);
      if (response.data) {
        set({ queueStatus: response.data });
      }
    } catch {
      // Ignore status check errors
    }
  },

  leaveQueue: async (eventId) => {
    try {
      await queueApi.leave(eventId);
      set({ queueStatus: null });
    } catch {
      // Ignore leave errors
    }
  },

  checkout: async (paymentMethod) => {
    set({ isLoading: true, error: null });
    try {
      const response = await checkoutApi.checkout(paymentMethod);
      if (response.data) {
        get().clearSelection();
        set({ isLoading: false });
        return { orderId: response.data.order.id };
      }
      throw new Error('Checkout failed');
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Checkout failed', isLoading: false });
      throw error;
    }
  },

  startCheckoutTimer: (expiresAt) => {
    get().stopCheckoutTimer();

    const updateTimer = () => {
      const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      set({ checkoutTimer: remaining });

      if (remaining <= 0) {
        get().stopCheckoutTimer();
        set({ reservation: null, selectedSeats: [], error: 'Reservation expired' });
      }
    };

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  },

  stopCheckoutTimer: () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    set({ checkoutTimer: null });
  },

  clearError: () => set({ error: null }),
}));
