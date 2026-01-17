/**
 * Global application state store using Zustand.
 *
 * Manages all client-side state including:
 * - User authentication status
 * - Canvas configuration and pixel data
 * - View state (zoom, pan, selected color)
 * - Cooldown tracking
 * - WebSocket connection status
 */
import { create } from 'zustand';
import type { User, CanvasConfig, PixelEvent, CooldownStatus } from '../types';
import { authApi, canvasApi } from '../services/api';
import { wsService } from '../services/websocket';

/**
 * Application state interface defining all store properties and actions.
 */
interface AppState {
  // User state
  /** Currently authenticated user, or null if not logged in. */
  user: User | null;
  /** Whether the user is authenticated. */
  isAuthenticated: boolean;
  /** Whether the app is in initial loading state. */
  isLoading: boolean;

  // Canvas state
  /** Canvas configuration from the server. */
  config: CanvasConfig | null;
  /** Canvas pixel data as a Uint8Array (each byte is a color index). */
  canvas: Uint8Array | null;
  /** Currently selected color index for placement. */
  selectedColor: number;
  /** Currently hovered pixel coordinates, or null if none. */
  hoveredPixel: { x: number; y: number } | null;
  /** Current zoom level (1 = 100%). */
  zoom: number;
  /** Current pan offset in pixels. */
  panOffset: { x: number; y: number };

  // Cooldown state
  /** User's cooldown status for pixel placement. */
  cooldown: CooldownStatus | null;
  /** Interval timer ID for countdown updates. */
  cooldownTimer: number | null;

  // Connection state
  /** Whether WebSocket is connected. */
  isConnected: boolean;

  // Actions
  /** Initializes the application by loading config and connecting to WebSocket. */
  initialize: () => Promise<void>;
  /** Logs in a user with username and password. */
  login: (username: string, password: string) => Promise<void>;
  /** Registers a new user. */
  register: (username: string, password: string) => Promise<void>;
  /** Logs out the current user. */
  logout: () => Promise<void>;
  /** Creates an anonymous guest session. */
  loginAnonymous: () => Promise<void>;
  /** Sets the currently selected color. */
  setSelectedColor: (color: number) => void;
  /** Sets the currently hovered pixel. */
  setHoveredPixel: (pixel: { x: number; y: number } | null) => void;
  /** Sets the zoom level (clamped to 0.5-20). */
  setZoom: (zoom: number) => void;
  /** Sets the pan offset. */
  setPanOffset: (offset: { x: number; y: number }) => void;
  /** Places a pixel at the specified coordinates. */
  placePixel: (x: number, y: number) => Promise<void>;
  /** Updates a single pixel from a WebSocket event. */
  updatePixel: (event: PixelEvent) => void;
  /** Sets the entire canvas from base64 data. */
  setCanvas: (canvasData: string) => void;
  /** Updates the cooldown status. */
  updateCooldown: (status: CooldownStatus) => void;
  /** Sets the connection status. */
  setConnected: (connected: boolean) => void;
}

/**
 * Zustand store hook for accessing and modifying application state.
 * Use destructuring to select only needed state slices for performance.
 */
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

  /**
   * Initializes the application.
   * Loads canvas configuration, checks authentication, and connects to WebSocket.
   */
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

  /**
   * Authenticates a user and reconnects WebSocket with new session.
   */
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

  /**
   * Registers a new user and reconnects WebSocket with new session.
   */
  register: async (username, password) => {
    const { user } = await authApi.register(username, password);
    set({
      user: user as User,
      isAuthenticated: true,
    });
    wsService.disconnect();
    wsService.connect();
  },

  /**
   * Logs out the current user and reconnects WebSocket without session.
   */
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

  /**
   * Creates an anonymous guest session for quick access.
   */
  loginAnonymous: async () => {
    const { user } = await authApi.anonymous();
    set({
      user: user as User,
      isAuthenticated: true,
    });
    wsService.disconnect();
    wsService.connect();
  },

  // Canvas view state setters
  setSelectedColor: (color) => set({ selectedColor: color }),
  setHoveredPixel: (pixel) => set({ hoveredPixel: pixel }),
  setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(20, zoom)) }),
  setPanOffset: (offset) => set({ panOffset: offset }),

  /**
   * Decodes base64 canvas data and stores it as Uint8Array.
   */
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

  /**
   * Updates a single pixel in the local canvas state.
   * Called when receiving pixel updates from WebSocket.
   */
  updatePixel: (event) => {
    const { canvas, config } = get();
    if (!canvas || !config) return;

    const offset = event.y * config.width + event.x;
    const newCanvas = new Uint8Array(canvas);
    newCanvas[offset] = event.color;
    set({ canvas: newCanvas });
  },

  /**
   * Places a pixel on the canvas via API.
   * Starts cooldown timer on success.
   *
   * @throws Error if not authenticated or in cooldown.
   */
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

  /**
   * Updates cooldown status and starts countdown timer.
   * Clears any existing timer before starting a new one.
   */
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

  /** Updates WebSocket connection status. */
  setConnected: (connected) => set({ isConnected: connected }),
}));
