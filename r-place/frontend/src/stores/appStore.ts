import { create } from 'zustand';
import type { User, CanvasConfig, PixelEvent, CooldownStatus } from '../types';
import { authApi, canvasApi } from '../services/api';
import { wsService } from '../services/websocket';

interface AppState {
  // User state
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Canvas state
  config: CanvasConfig | null;
  canvas: Uint8Array | null;
  selectedColor: number;
  hoveredPixel: { x: number; y: number } | null;
  zoom: number;
  panOffset: { x: number; y: number };

  // Cooldown state
  cooldown: CooldownStatus | null;
  cooldownTimer: number | null;

  // Connection state
  isConnected: boolean;

  // Actions
  initialize: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loginAnonymous: () => Promise<void>;
  setSelectedColor: (color: number) => void;
  setHoveredPixel: (pixel: { x: number; y: number } | null) => void;
  setZoom: (zoom: number) => void;
  setPanOffset: (offset: { x: number; y: number }) => void;
  placePixel: (x: number, y: number) => Promise<void>;
  updatePixel: (event: PixelEvent) => void;
  setCanvas: (canvasData: string) => void;
  updateCooldown: (status: CooldownStatus) => void;
  setConnected: (connected: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  user: null,
  isAuthenticated: false,
  isLoading: true,
  config: null,
  canvas: null,
  selectedColor: 5, // Red
  hoveredPixel: null,
  zoom: 1,
  panOffset: { x: 0, y: 0 },
  cooldown: null,
  cooldownTimer: null,
  isConnected: false,

  // Initialize the app
  initialize: async () => {
    set({ isLoading: true });

    try {
      // Load canvas config
      const config = await canvasApi.getConfig();
      set({ config });

      // Check if user is authenticated
      try {
        const { user } = await authApi.me();
        set({
          user: user as User,
          isAuthenticated: true,
        });
      } catch {
        // Not authenticated, that's okay
      }

      // Connect to WebSocket
      wsService.connect();

      // Set up WebSocket handlers
      wsService.onMessage((message) => {
        switch (message.type) {
          case 'canvas':
            get().setCanvas(message.data as string);
            break;
          case 'pixel':
            get().updatePixel(message.data as PixelEvent);
            break;
          case 'pixels':
            (message.data as PixelEvent[]).forEach((event) => {
              get().updatePixel(event);
            });
            break;
          case 'cooldown':
            get().updateCooldown(message.data as CooldownStatus);
            break;
          case 'connected':
            console.log('WebSocket confirmed connected:', message.data);
            break;
        }
      });

      wsService.onConnect(() => {
        set({ isConnected: true });
      });

      wsService.onDisconnect(() => {
        set({ isConnected: false });
      });
    } catch (error) {
      console.error('Failed to initialize:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  // Auth actions
  login: async (username, password) => {
    const { user } = await authApi.login(username, password);
    set({
      user: user as User,
      isAuthenticated: true,
    });
    // Reconnect WebSocket to get authenticated session
    wsService.disconnect();
    wsService.connect();
  },

  register: async (username, password) => {
    const { user } = await authApi.register(username, password);
    set({
      user: user as User,
      isAuthenticated: true,
    });
    wsService.disconnect();
    wsService.connect();
  },

  logout: async () => {
    await authApi.logout();
    set({
      user: null,
      isAuthenticated: false,
      cooldown: null,
    });
    wsService.disconnect();
    wsService.connect();
  },

  loginAnonymous: async () => {
    const { user } = await authApi.anonymous();
    set({
      user: user as User,
      isAuthenticated: true,
    });
    wsService.disconnect();
    wsService.connect();
  },

  // Canvas actions
  setSelectedColor: (color) => set({ selectedColor: color }),
  setHoveredPixel: (pixel) => set({ hoveredPixel: pixel }),
  setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(20, zoom)) }),
  setPanOffset: (offset) => set({ panOffset: offset }),

  setCanvas: (canvasData) => {
    try {
      const binaryString = atob(canvasData);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      set({ canvas: bytes });
    } catch (error) {
      console.error('Failed to decode canvas:', error);
    }
  },

  updatePixel: (event) => {
    const { canvas, config } = get();
    if (!canvas || !config) return;

    const offset = event.y * config.width + event.x;
    const newCanvas = new Uint8Array(canvas);
    newCanvas[offset] = event.color;
    set({ canvas: newCanvas });
  },

  placePixel: async (x, y) => {
    const { selectedColor, cooldown, isAuthenticated } = get();

    if (!isAuthenticated) {
      throw new Error('Please sign in to place pixels');
    }

    if (cooldown && !cooldown.canPlace) {
      throw new Error(`Wait ${cooldown.remainingSeconds} seconds`);
    }

    try {
      const result = await canvasApi.placePixel(x, y, selectedColor);
      if (result.success && result.nextPlacement) {
        const remainingSeconds = Math.ceil(
          (result.nextPlacement - Date.now()) / 1000
        );
        set({
          cooldown: {
            canPlace: false,
            remainingSeconds,
            nextPlacement: result.nextPlacement,
          },
        });

        // Start cooldown timer
        const startCooldownTimer = () => {
          const timer = window.setInterval(() => {
            const current = get().cooldown;
            if (!current) {
              clearInterval(timer);
              return;
            }

            const remaining = Math.ceil(
              (current.nextPlacement - Date.now()) / 1000
            );

            if (remaining <= 0) {
              set({
                cooldown: {
                  canPlace: true,
                  remainingSeconds: 0,
                  nextPlacement: Date.now(),
                },
                cooldownTimer: null,
              });
              clearInterval(timer);
            } else {
              set({
                cooldown: {
                  ...current,
                  remainingSeconds: remaining,
                },
              });
            }
          }, 1000);

          set({ cooldownTimer: timer });
        };

        startCooldownTimer();
      }
    } catch (error) {
      console.error('Failed to place pixel:', error);
      throw error;
    }
  },

  updateCooldown: (status) => {
    set({ cooldown: status });

    // Clear existing timer
    const existingTimer = get().cooldownTimer;
    if (existingTimer) {
      clearInterval(existingTimer);
    }

    if (!status.canPlace) {
      const timer = window.setInterval(() => {
        const current = get().cooldown;
        if (!current) {
          clearInterval(timer);
          return;
        }

        const remaining = Math.ceil(
          (current.nextPlacement - Date.now()) / 1000
        );

        if (remaining <= 0) {
          set({
            cooldown: {
              canPlace: true,
              remainingSeconds: 0,
              nextPlacement: Date.now(),
            },
            cooldownTimer: null,
          });
          clearInterval(timer);
        } else {
          set({
            cooldown: {
              ...current,
              remainingSeconds: remaining,
            },
          });
        }
      }, 1000);

      set({ cooldownTimer: timer });
    }
  },

  setConnected: (connected) => set({ isConnected: connected }),
}));
