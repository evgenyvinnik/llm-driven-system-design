# Online Auction System - Fullstack System Design Interview Answer

## Introduction (2 minutes)

"Thanks for this problem. I'll be designing an online auction platform covering both frontend and backend, with emphasis on the integration points between them. I'll focus on real-time bid synchronization, the API contract, type safety across the stack, and ensuring a consistent experience during high-activity periods."

---

## 1. Requirements Clarification (5 minutes)

### Functional Requirements

1. **Auction Lifecycle** - Create, list, bid, auto-bid, end auctions
2. **Real-Time Sync** - Bidders see updates instantly across devices
3. **Anti-Sniping** - Extend auctions on last-minute bids
4. **User Management** - Registration, authentication, watchlists
5. **Admin Operations** - Cancel auctions, ban users, view analytics

### Integration-Focused Non-Functional Requirements

- **Type Safety** - Shared types between frontend and backend
- **Real-Time Latency** - Bid updates delivered within 500ms
- **Optimistic Updates** - Immediate UI feedback with server reconciliation
- **Idempotency** - Safe retries for all mutation operations
- **Graceful Degradation** - Fallback when WebSocket fails

---

## 2. Shared Type Definitions (5 minutes)

"Shared types ensure contract consistency between frontend and backend."

### Core Domain Types

```typescript
// shared/types/auction.ts

export interface Auction {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  category: string;
  startingPrice: number;
  currentBid: number;
  currentBidderId: string | null;
  reservePrice: number | null;
  bidIncrement: number;
  bidCount: number;
  status: AuctionStatus;
  startTime: string; // ISO 8601
  endTime: string;
  originalEndTime: string;
  createdAt: string;
  updatedAt: string;
}

export type AuctionStatus =
  | 'draft'
  | 'active'
  | 'ended'
  | 'sold'
  | 'unsold'
  | 'cancelled';

export interface AuctionImage {
  id: string;
  auctionId: string;
  url: string;
  thumbnailUrl: string;
  displayOrder: number;
}

export interface Bid {
  id: string;
  auctionId: string;
  bidderId: string;
  bidderName: string; // Anonymized display name
  amount: number;
  maxAmount?: number; // Only visible to bid owner
  isProxyBid: boolean;
  isWinning: boolean;
  createdAt: string;
}

export interface AutoBid {
  id: string;
  auctionId: string;
  bidderId: string;
  maxAmount: number;
  currentBid: number;
  isActive: boolean;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: 'user' | 'admin';
  createdAt: string;
}
```

### API Request/Response Types

```typescript
// shared/types/api.ts

// Place Bid
export interface PlaceBidRequest {
  amount: number;
  maxAmount?: number; // Optional: sets up auto-bid
}

export interface PlaceBidResponse {
  bidId: string;
  status: 'accepted' | 'pending' | 'rejected';
  finalAmount: number;
  isHighestBidder: boolean;
  message: string;
  auctionEndTime: string; // May have changed due to anti-sniping
}

// Set Auto-Bid
export interface SetAutoBidRequest {
  maxAmount: number;
}

export interface SetAutoBidResponse {
  autoBidId: string;
  currentBid: number;
  maxAmount: number;
  isActive: boolean;
}

// Create Auction
export interface CreateAuctionRequest {
  title: string;
  description: string;
  category: string;
  startingPrice: number;
  reservePrice?: number;
  bidIncrement?: number;
  startTime?: string;
  endTime: string;
  images: File[];
}

export interface CreateAuctionResponse {
  auctionId: string;
  status: 'draft' | 'active';
}

// Pagination
export interface PaginatedRequest {
  page?: number;
  limit?: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Error Response
export interface ApiError {
  error: string;
  message: string;
  details?: Record<string, string>;
}
```

### WebSocket Message Types

```typescript
// shared/types/websocket.ts

export type WsMessageType =
  | 'bid_update'
  | 'auction_extended'
  | 'auction_ended'
  | 'outbid_notification'
  | 'connection_ack'
  | 'error';

export interface WsMessage<T = unknown> {
  type: WsMessageType;
  auctionId: string;
  timestamp: string;
  data: T;
}

export interface BidUpdateData {
  bidId: string;
  amount: number;
  bidderId: string;
  bidderName: string;
  bidCount: number;
  isProxyBid: boolean;
}

export interface AuctionExtendedData {
  previousEndTime: string;
  newEndTime: string;
  reason: 'snipe_protection';
  triggeringBidId: string;
}

export interface AuctionEndedData {
  finalAmount: number;
  winnerId: string | null;
  winnerName: string | null;
  reserveMet: boolean;
  outcome: 'sold' | 'unsold' | 'cancelled';
}

export interface OutbidNotificationData {
  auctionId: string;
  auctionTitle: string;
  newAmount: number;
  yourMaxBid: number;
  canAutoBid: boolean;
}
```

---

## 3. WebSocket Integration (10 minutes)

"Real-time synchronization is critical for auction UX. Here's the full-stack implementation."

### Backend: WebSocket Server

```typescript
// backend/src/websocket/auctionSocket.ts
import { WebSocket, WebSocketServer } from 'ws';
import { Redis } from 'ioredis';
import { WsMessage, BidUpdateData, AuctionExtendedData } from '../../shared/types/websocket';

interface ConnectedClient {
  ws: WebSocket;
  userId: string | null;
  watchedAuctions: Set<string>;
}

export class AuctionWebSocketServer {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ConnectedClient> = new Map();
  private auctionSubscribers: Map<string, Set<WebSocket>> = new Map();
  private redisSub: Redis;
  private redisPub: Redis;

  constructor(server: http.Server, redisUrl: string) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.redisSub = new Redis(redisUrl);
    this.redisPub = new Redis(redisUrl);

    this.setupRedisSubscriptions();
    this.setupWebSocketHandlers();
  }

  private setupRedisSubscriptions() {
    this.redisSub.psubscribe('auction:*');

    this.redisSub.on('pmessage', (pattern, channel, message) => {
      const auctionId = channel.split(':')[1];
      const data = JSON.parse(message);

      this.broadcastToAuction(auctionId, data);
    });
  }

  private setupWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      const client: ConnectedClient = {
        ws,
        userId: this.extractUserId(req),
        watchedAuctions: new Set(),
      };
      this.clients.set(ws, client);

      // Send connection acknowledgment
      this.send(ws, {
        type: 'connection_ack',
        auctionId: '',
        timestamp: new Date().toISOString(),
        data: { connectionId: this.generateConnectionId() },
      });

      ws.on('message', (raw) => this.handleMessage(ws, raw));
      ws.on('close', () => this.handleDisconnect(ws));
      ws.on('error', (err) => console.error('WebSocket error:', err));
    });
  }

  private handleMessage(ws: WebSocket, raw: Buffer) {
    const message = JSON.parse(raw.toString());

    switch (message.type) {
      case 'subscribe':
        this.subscribeToAuction(ws, message.auctionId);
        break;
      case 'unsubscribe':
        this.unsubscribeFromAuction(ws, message.auctionId);
        break;
      case 'ping':
        this.send(ws, { type: 'pong', timestamp: Date.now() });
        break;
    }
  }

  private subscribeToAuction(ws: WebSocket, auctionId: string) {
    const client = this.clients.get(ws);
    if (!client) return;

    client.watchedAuctions.add(auctionId);

    if (!this.auctionSubscribers.has(auctionId)) {
      this.auctionSubscribers.set(auctionId, new Set());
    }
    this.auctionSubscribers.get(auctionId)!.add(ws);
  }

  private broadcastToAuction(auctionId: string, message: WsMessage) {
    const subscribers = this.auctionSubscribers.get(auctionId);
    if (!subscribers) return;

    const payload = JSON.stringify(message);
    for (const ws of subscribers) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  // Called by bid service after successful bid
  async publishBidUpdate(auctionId: string, data: BidUpdateData) {
    const message: WsMessage<BidUpdateData> = {
      type: 'bid_update',
      auctionId,
      timestamp: new Date().toISOString(),
      data,
    };

    await this.redisPub.publish(`auction:${auctionId}`, JSON.stringify(message));
  }

  // Called when auction is extended
  async publishAuctionExtended(auctionId: string, data: AuctionExtendedData) {
    const message: WsMessage<AuctionExtendedData> = {
      type: 'auction_extended',
      auctionId,
      timestamp: new Date().toISOString(),
      data,
    };

    await this.redisPub.publish(`auction:${auctionId}`, JSON.stringify(message));
  }

  private handleDisconnect(ws: WebSocket) {
    const client = this.clients.get(ws);
    if (client) {
      for (const auctionId of client.watchedAuctions) {
        this.auctionSubscribers.get(auctionId)?.delete(ws);
      }
    }
    this.clients.delete(ws);
  }

  private send(ws: WebSocket, message: object) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }
}
```

### Frontend: WebSocket Hook

```typescript
// frontend/src/hooks/useAuctionSocket.ts
import { useEffect, useRef, useCallback, useState } from 'react';
import { useAuctionStore } from '../stores/auctionStore';
import { WsMessage, BidUpdateData, AuctionExtendedData, AuctionEndedData } from '../../../shared/types/websocket';

interface UseAuctionSocketOptions {
  onBidUpdate?: (data: BidUpdateData) => void;
  onAuctionExtended?: (data: AuctionExtendedData) => void;
  onAuctionEnded?: (data: AuctionEndedData) => void;
  onOutbid?: (auctionId: string, newAmount: number) => void;
}

export function useAuctionSocket(
  auctionId: string,
  options: UseAuctionSocketOptions = {}
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const [isConnected, setIsConnected] = useState(false);

  const { updateFromSocket } = useAuctionStore();

  const connect = useCallback(() => {
    const wsUrl = `${import.meta.env.VITE_WS_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setIsConnected(true);
      reconnectAttempts.current = 0;

      // Subscribe to this auction
      ws.send(JSON.stringify({ type: 'subscribe', auctionId }));
    };

    ws.onmessage = (event) => {
      const message: WsMessage = JSON.parse(event.data);

      if (message.auctionId !== auctionId && message.type !== 'connection_ack') {
        return;
      }

      switch (message.type) {
        case 'bid_update':
          const bidData = message.data as BidUpdateData;
          updateFromSocket(auctionId, {
            currentBid: bidData.amount,
            currentBidderId: bidData.bidderId,
            bidCount: bidData.bidCount,
          });
          options.onBidUpdate?.(bidData);
          break;

        case 'auction_extended':
          const extData = message.data as AuctionExtendedData;
          updateFromSocket(auctionId, {
            endTime: extData.newEndTime,
          });
          options.onAuctionExtended?.(extData);
          break;

        case 'auction_ended':
          const endData = message.data as AuctionEndedData;
          updateFromSocket(auctionId, {
            status: endData.outcome,
          });
          options.onAuctionEnded?.(endData);
          break;

        case 'outbid_notification':
          options.onOutbid?.(auctionId, (message.data as any).newAmount);
          break;
      }
    };

    ws.onclose = (event) => {
      setIsConnected(false);

      if (!event.wasClean && reconnectAttempts.current < 5) {
        const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 30000);
        reconnectAttempts.current++;
        setTimeout(connect, delay);
      }
    };

    wsRef.current = ws;
  }, [auctionId, updateFromSocket, options]);

  useEffect(() => {
    connect();

    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  const unsubscribe = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'unsubscribe', auctionId }));
    }
  }, [auctionId]);

  return { isConnected, unsubscribe };
}
```

---

## 4. API Integration Layer (8 minutes)

### Backend: Express Routes

```typescript
// backend/src/routes/auctions.ts
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { BidService } from '../services/bidService';
import { AuctionService } from '../services/auctionService';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import {
  PlaceBidRequest,
  PlaceBidResponse,
  SetAutoBidRequest,
  ApiError,
} from '../../shared/types/api';

const router = Router();
const bidService = new BidService();
const auctionService = new AuctionService();

// Validation schemas
const placeBidSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  maxAmount: z.number().positive().optional(),
});

const setAutoBidSchema = z.object({
  maxAmount: z.number().positive().multipleOf(0.01),
});

// Place bid
router.post(
  '/:auctionId/bids',
  requireAuth,
  rateLimit({ window: 60, max: 10 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { auctionId } = req.params;
      const idempotencyKey = req.headers['x-idempotency-key'] as string;

      // Validate request body
      const parseResult = placeBidSchema.safeParse(req.body);
      if (!parseResult.success) {
        const error: ApiError = {
          error: 'VALIDATION_ERROR',
          message: 'Invalid bid data',
          details: parseResult.error.flatten().fieldErrors,
        };
        return res.status(400).json(error);
      }

      const { amount, maxAmount } = parseResult.data;

      const result = await bidService.placeBid({
        auctionId,
        bidderId: req.user!.id,
        amount,
        maxAmount,
        idempotencyKey,
      });

      const response: PlaceBidResponse = {
        bidId: result.bidId,
        status: 'accepted',
        finalAmount: result.finalAmount,
        isHighestBidder: result.isHighestBidder,
        message: result.message,
        auctionEndTime: result.auctionEndTime,
      };

      res.status(201).json(response);
    } catch (error) {
      next(error);
    }
  }
);

// Set auto-bid
router.post(
  '/:auctionId/proxy',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { auctionId } = req.params;

      const parseResult = setAutoBidSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Invalid auto-bid data',
        });
      }

      const result = await bidService.setAutoBid({
        auctionId,
        bidderId: req.user!.id,
        maxAmount: parseResult.data.maxAmount,
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Get bid history
router.get(
  '/:auctionId/bids',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { auctionId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      const result = await auctionService.getBidHistory(
        auctionId,
        Number(page),
        Number(limit)
      );

      res.json(result);
    } catch (error) {
      next(error);
    }
  }
);

// Error handling middleware
router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  if (error.name === 'BidTooLowError') {
    return res.status(400).json({
      error: 'BID_TOO_LOW',
      message: error.message,
    });
  }

  if (error.name === 'AuctionEndedError') {
    return res.status(409).json({
      error: 'AUCTION_ENDED',
      message: error.message,
    });
  }

  if (error.name === 'LockError') {
    return res.status(429).json({
      error: 'TOO_MANY_BIDS',
      message: 'Too many concurrent bids. Please try again.',
    });
  }

  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
});

export default router;
```

### Frontend: API Client

```typescript
// frontend/src/api/client.ts
import {
  Auction,
  Bid,
  PlaceBidRequest,
  PlaceBidResponse,
  SetAutoBidRequest,
  SetAutoBidResponse,
  PaginatedResponse,
  ApiError,
} from '../../../shared/types';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

class ApiClient {
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;

    const response = await fetch(url, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error: ApiError = await response.json();
      throw new ApiClientError(error.error, error.message, response.status);
    }

    return response.json();
  }

  // Auctions
  async getAuctions(params?: {
    page?: number;
    limit?: number;
    category?: string;
    search?: string;
    status?: string;
  }): Promise<PaginatedResponse<Auction>> {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) searchParams.set(key, String(value));
      });
    }
    return this.request(`/auctions?${searchParams}`);
  }

  async getAuction(auctionId: string): Promise<Auction> {
    return this.request(`/auctions/${auctionId}`);
  }

  // Bidding
  async placeBid(
    auctionId: string,
    data: PlaceBidRequest,
    idempotencyKey: string
  ): Promise<PlaceBidResponse> {
    return this.request(`/auctions/${auctionId}/bids`, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
    });
  }

  async setAutoBid(
    auctionId: string,
    data: SetAutoBidRequest
  ): Promise<SetAutoBidResponse> {
    return this.request(`/auctions/${auctionId}/proxy`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getBidHistory(
    auctionId: string,
    page = 1,
    limit = 20
  ): Promise<PaginatedResponse<Bid>> {
    return this.request(`/auctions/${auctionId}/bids?page=${page}&limit=${limit}`);
  }

  // Watchlist
  async getWatchlist(): Promise<Auction[]> {
    return this.request('/users/me/watchlist');
  }

  async addToWatchlist(auctionId: string): Promise<void> {
    return this.request('/users/me/watchlist', {
      method: 'POST',
      body: JSON.stringify({ auctionId }),
    });
  }

  async removeFromWatchlist(auctionId: string): Promise<void> {
    return this.request(`/users/me/watchlist/${auctionId}`, {
      method: 'DELETE',
    });
  }
}

class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export const apiClient = new ApiClient();
```

### Frontend: React Query Hooks

```typescript
// frontend/src/hooks/useAuction.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { v4 as uuidv4 } from 'uuid';

export function useAuction(auctionId: string) {
  return useQuery({
    queryKey: ['auction', auctionId],
    queryFn: () => apiClient.getAuction(auctionId),
    staleTime: 5000, // Consider fresh for 5 seconds
    refetchInterval: 30000, // Fallback polling if WebSocket fails
  });
}

export function useBidHistory(auctionId: string, page = 1) {
  return useQuery({
    queryKey: ['auction', auctionId, 'bids', page],
    queryFn: () => apiClient.getBidHistory(auctionId, page),
    staleTime: 10000,
  });
}

export function usePlaceBid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      auctionId,
      amount,
      maxAmount,
    }: {
      auctionId: string;
      amount: number;
      maxAmount?: number;
    }) => {
      const idempotencyKey = uuidv4();
      return apiClient.placeBid(auctionId, { amount, maxAmount }, idempotencyKey);
    },

    onMutate: async ({ auctionId, amount }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['auction', auctionId] });

      // Snapshot the previous value
      const previousAuction = queryClient.getQueryData(['auction', auctionId]);

      // Optimistically update to the new value
      queryClient.setQueryData(['auction', auctionId], (old: any) => ({
        ...old,
        currentBid: amount,
        bidCount: (old?.bidCount || 0) + 1,
      }));

      return { previousAuction };
    },

    onError: (err, { auctionId }, context) => {
      // Rollback on error
      if (context?.previousAuction) {
        queryClient.setQueryData(['auction', auctionId], context.previousAuction);
      }
    },

    onSettled: (_, __, { auctionId }) => {
      // Refetch to ensure we have the latest data
      queryClient.invalidateQueries({ queryKey: ['auction', auctionId] });
      queryClient.invalidateQueries({ queryKey: ['auction', auctionId, 'bids'] });
    },
  });
}

export function useSetAutoBid() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      auctionId,
      maxAmount,
    }: {
      auctionId: string;
      maxAmount: number;
    }) => {
      return apiClient.setAutoBid(auctionId, { maxAmount });
    },

    onSuccess: (_, { auctionId }) => {
      queryClient.invalidateQueries({ queryKey: ['auction', auctionId] });
    },
  });
}
```

---

## 5. Bid Processing Flow (8 minutes)

### Complete Bid Flow: Frontend to Backend to Real-Time Update

```typescript
// backend/src/services/bidService.ts
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { wsServer } from '../websocket/server';
import { BidUpdateData } from '../../shared/types/websocket';

interface PlaceBidInput {
  auctionId: string;
  bidderId: string;
  amount: number;
  maxAmount?: number;
  idempotencyKey?: string;
}

interface PlaceBidResult {
  bidId: string;
  finalAmount: number;
  isHighestBidder: boolean;
  message: string;
  auctionEndTime: string;
}

export class BidService {
  private readonly SNIPE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

  async placeBid(input: PlaceBidInput): Promise<PlaceBidResult> {
    const { auctionId, bidderId, amount, maxAmount, idempotencyKey } = input;

    // 1. Check idempotency
    if (idempotencyKey) {
      const existing = await this.checkIdempotency(idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    // 2. Acquire distributed lock
    const lockKey = `lock:auction:${auctionId}`;
    const lockId = await this.acquireLock(lockKey, 5000);

    if (!lockId) {
      throw new LockError('Too many concurrent bids');
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 3. Fetch auction with row lock
      const auctionResult = await client.query(
        `SELECT * FROM auctions WHERE id = $1 FOR UPDATE`,
        [auctionId]
      );
      const auction = auctionResult.rows[0];

      // 4. Validate bid
      this.validateBid(auction, bidderId, amount);

      // 5. Get competing auto-bids
      const autoBidsResult = await client.query(
        `SELECT * FROM auto_bids
         WHERE auction_id = $1 AND bidder_id != $2 AND is_active = true
         ORDER BY max_amount DESC`,
        [auctionId, bidderId]
      );
      const competingAutoBids = autoBidsResult.rows;

      // 6. Resolve auto-bidding
      const { finalAmount, winnerId, isAutoBid } = this.resolveAutoBids(
        amount,
        maxAmount,
        bidderId,
        competingAutoBids,
        auction.bid_increment
      );

      // 7. Insert bid record
      const bidResult = await client.query(
        `INSERT INTO bids (auction_id, bidder_id, amount, max_amount, is_proxy_bid, is_winning, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         RETURNING id`,
        [auctionId, winnerId, finalAmount, maxAmount, isAutoBid, idempotencyKey]
      );
      const bidId = bidResult.rows[0].id;

      // 8. Mark previous winning bid as not winning
      await client.query(
        `UPDATE bids SET is_winning = false
         WHERE auction_id = $1 AND is_winning = true AND id != $2`,
        [auctionId, bidId]
      );

      // 9. Check anti-sniping
      let newEndTime = auction.end_time;
      const timeRemaining = new Date(auction.end_time).getTime() - Date.now();

      if (timeRemaining < this.SNIPE_WINDOW_MS) {
        newEndTime = new Date(Date.now() + this.SNIPE_WINDOW_MS);

        await client.query(
          `UPDATE auctions SET end_time = $1 WHERE id = $2`,
          [newEndTime, auctionId]
        );

        // Update scheduler
        await redis.zadd('auction_endings', {
          [auctionId]: newEndTime.getTime(),
        });
      }

      // 10. Update auction state
      const updateResult = await client.query(
        `UPDATE auctions
         SET current_high_bid = $1, current_high_bidder_id = $2, updated_at = NOW()
         WHERE id = $3
         RETURNING (SELECT COUNT(*) FROM bids WHERE auction_id = $3) as bid_count`,
        [finalAmount, winnerId, auctionId]
      );

      await client.query('COMMIT');

      // 11. Cache invalidation
      await redis.del(`auction:${auctionId}`);
      await redis.del(`auction:${auctionId}:bids`);

      // 12. Publish real-time update
      const bidUpdate: BidUpdateData = {
        bidId,
        amount: finalAmount,
        bidderId: winnerId,
        bidderName: await this.getAnonymizedName(winnerId),
        bidCount: parseInt(updateResult.rows[0].bid_count),
        isProxyBid: isAutoBid,
      };

      await wsServer.publishBidUpdate(auctionId, bidUpdate);

      // 13. Publish extension if applicable
      if (newEndTime !== auction.end_time) {
        await wsServer.publishAuctionExtended(auctionId, {
          previousEndTime: auction.end_time,
          newEndTime: newEndTime.toISOString(),
          reason: 'snipe_protection',
          triggeringBidId: bidId,
        });
      }

      // 14. Notify outbid user
      if (auction.current_high_bidder_id && auction.current_high_bidder_id !== winnerId) {
        await this.notifyOutbidUser(
          auction.current_high_bidder_id,
          auctionId,
          finalAmount
        );
      }

      return {
        bidId,
        finalAmount,
        isHighestBidder: winnerId === bidderId,
        message: winnerId === bidderId
          ? 'You are now the highest bidder!'
          : 'Another bidder auto-bid higher. Increase your maximum bid.',
        auctionEndTime: newEndTime.toISOString(),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await this.releaseLock(lockKey, lockId);
    }
  }

  private resolveAutoBids(
    newAmount: number,
    newMaxAmount: number | undefined,
    newBidderId: string,
    competingAutoBids: any[],
    bidIncrement: number
  ): { finalAmount: number; winnerId: string; isAutoBid: boolean } {
    if (competingAutoBids.length === 0) {
      return {
        finalAmount: newAmount,
        winnerId: newBidderId,
        isAutoBid: false,
      };
    }

    const highestAutoBid = competingAutoBids[0];
    const effectiveNewMax = newMaxAmount || newAmount;

    if (effectiveNewMax > highestAutoBid.max_amount) {
      // New bidder wins
      return {
        finalAmount: Math.min(
          highestAutoBid.max_amount + bidIncrement,
          effectiveNewMax
        ),
        winnerId: newBidderId,
        isAutoBid: !!newMaxAmount,
      };
    } else {
      // Existing auto-bidder wins
      return {
        finalAmount: Math.min(
          effectiveNewMax + bidIncrement,
          highestAutoBid.max_amount
        ),
        winnerId: highestAutoBid.bidder_id,
        isAutoBid: true,
      };
    }
  }

  private validateBid(auction: any, bidderId: string, amount: number) {
    if (!auction) {
      throw new NotFoundError('Auction not found');
    }

    if (auction.status !== 'active') {
      throw new AuctionEndedError('This auction has ended');
    }

    if (new Date(auction.end_time) < new Date()) {
      throw new AuctionEndedError('This auction has ended');
    }

    if (auction.seller_id === bidderId) {
      throw new ValidationError('Sellers cannot bid on their own auctions');
    }

    const minimumBid = (auction.current_high_bid || auction.starting_price)
      + auction.bid_increment;

    if (amount < minimumBid) {
      throw new BidTooLowError(
        `Bid must be at least $${minimumBid.toFixed(2)}`
      );
    }
  }

  private async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const lockId = uuidv4();
    const result = await redis.set(key, lockId, 'PX', ttlMs, 'NX');
    return result === 'OK' ? lockId : null;
  }

  private async releaseLock(key: string, lockId: string): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(script, 1, key, lockId);
  }
}
```

---

## 6. State Synchronization Pattern (5 minutes)

### Frontend Store with Server Reconciliation

```typescript
// frontend/src/stores/auctionStore.ts
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { Auction } from '../../../shared/types';

interface AuctionState {
  auctions: Record<string, Auction>;
  pendingBids: Record<string, { amount: number; timestamp: number }>;
  lastServerSync: Record<string, number>;

  // Actions
  setAuction: (auction: Auction) => void;
  updateFromSocket: (auctionId: string, update: Partial<Auction>) => void;
  optimisticBid: (auctionId: string, amount: number) => void;
  confirmBid: (auctionId: string, serverData: { finalAmount: number }) => void;
  rollbackBid: (auctionId: string) => void;
}

export const useAuctionStore = create<AuctionState>()(
  immer((set, get) => ({
    auctions: {},
    pendingBids: {},
    lastServerSync: {},

    setAuction: (auction) => {
      set((state) => {
        state.auctions[auction.id] = auction;
        state.lastServerSync[auction.id] = Date.now();
      });
    },

    updateFromSocket: (auctionId, update) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (!auction) return;

        const pendingBid = state.pendingBids[auctionId];

        // If we have a pending bid that's higher than the update,
        // keep our optimistic state (server hasn't processed ours yet)
        if (pendingBid && update.currentBid && pendingBid.amount > update.currentBid) {
          // Skip this update, our pending bid is higher
          return;
        }

        // Apply the update
        Object.assign(auction, update);
        state.lastServerSync[auctionId] = Date.now();
      });
    },

    optimisticBid: (auctionId, amount) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (!auction) return;

        // Store previous state for potential rollback
        state.pendingBids[auctionId] = {
          amount,
          timestamp: Date.now(),
        };

        // Apply optimistic update
        auction.currentBid = amount;
        auction.bidCount += 1;
      });
    },

    confirmBid: (auctionId, serverData) => {
      set((state) => {
        const auction = state.auctions[auctionId];
        if (!auction) return;

        // Clear pending bid
        delete state.pendingBids[auctionId];

        // Apply server confirmation (may differ from optimistic)
        auction.currentBid = serverData.finalAmount;
        state.lastServerSync[auctionId] = Date.now();
      });
    },

    rollbackBid: (auctionId) => {
      set((state) => {
        // The next WebSocket update or refetch will restore correct state
        delete state.pendingBids[auctionId];
      });
    },
  }))
);

// Selector hooks
export function useAuctionById(auctionId: string) {
  return useAuctionStore((state) => state.auctions[auctionId]);
}

export function useHasPendingBid(auctionId: string) {
  return useAuctionStore((state) => !!state.pendingBids[auctionId]);
}
```

---

## 7. Error Handling Across Stack (3 minutes)

### Shared Error Types

```typescript
// shared/errors.ts
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus: number = 500
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class BidTooLowError extends AppError {
  constructor(message: string, public minimumBid: number) {
    super('BID_TOO_LOW', message, 400);
  }
}

export class AuctionEndedError extends AppError {
  constructor(message = 'This auction has ended') {
    super('AUCTION_ENDED', message, 409);
  }
}

export class LockError extends AppError {
  constructor(message = 'Too many concurrent requests') {
    super('LOCK_TIMEOUT', message, 429);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
  }
}
```

### Frontend Error Handling

```typescript
// frontend/src/components/BidForm.tsx
import { usePlaceBid } from '../hooks/usePlaceBid';
import { ApiClientError } from '../api/client';

export function BidForm({ auctionId, currentBid, bidIncrement }: BidFormProps) {
  const [error, setError] = useState<string | null>(null);
  const { mutate: placeBid, isPending } = usePlaceBid();

  const handleSubmit = (amount: number) => {
    setError(null);

    placeBid(
      { auctionId, amount },
      {
        onError: (err) => {
          if (err instanceof ApiClientError) {
            switch (err.code) {
              case 'BID_TOO_LOW':
                setError(`Your bid is too low. Minimum: $${getMinimumBid()}`);
                break;
              case 'AUCTION_ENDED':
                setError('Sorry, this auction has ended.');
                break;
              case 'LOCK_TIMEOUT':
                setError('Too many bids right now. Please try again.');
                break;
              default:
                setError('Failed to place bid. Please try again.');
            }
          } else {
            setError('Network error. Please check your connection.');
          }
        },
      }
    );
  };

  // ... rest of component
}
```

---

## 8. Trade-offs and Alternatives (3 minutes)

| Decision | Chosen Approach | Trade-off | Alternative |
|----------|----------------|-----------|-------------|
| WebSocket vs SSE | WebSocket | Bidirectional, but more complex | SSE simpler, one-way only |
| Shared types | Monorepo with shared folder | Build complexity | Code generation from OpenAPI |
| Optimistic updates | Immediate UI update | Brief inconsistency | Wait for server (slower UX) |
| Auto-bid resolution | Server-side only | Client doesn't see outcome instantly | Client prediction (complex) |
| Idempotency | UUID per request | Client must generate | Server-generated (less control) |
| State sync | Zustand + WebSocket | Dual source of truth | Single source with polling |

---

## 9. Testing Strategy (2 minutes)

### Integration Test Example

```typescript
// backend/src/routes/auctions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from './app';
import { seedTestAuction, seedTestUser, getAuthCookie } from '../test/helpers';

describe('POST /api/v1/auctions/:id/bids', () => {
  let auction: any;
  let user: any;
  let authCookie: string;

  beforeEach(async () => {
    auction = await seedTestAuction({ currentBid: 50, bidIncrement: 1 });
    user = await seedTestUser();
    authCookie = await getAuthCookie(user);
  });

  it('accepts a valid bid', async () => {
    const response = await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Cookie', authCookie)
      .set('X-Idempotency-Key', 'test-key-1')
      .send({ amount: 55 });

    expect(response.status).toBe(201);
    expect(response.body.finalAmount).toBe(55);
    expect(response.body.isHighestBidder).toBe(true);
  });

  it('rejects a bid below minimum', async () => {
    const response = await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Cookie', authCookie)
      .send({ amount: 50 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('BID_TOO_LOW');
  });

  it('handles duplicate idempotency key', async () => {
    const idempotencyKey = 'test-key-2';

    // First request
    await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Cookie', authCookie)
      .set('X-Idempotency-Key', idempotencyKey)
      .send({ amount: 60 });

    // Duplicate request
    const response = await request(app)
      .post(`/api/v1/auctions/${auction.id}/bids`)
      .set('Cookie', authCookie)
      .set('X-Idempotency-Key', idempotencyKey)
      .send({ amount: 60 });

    expect(response.status).toBe(200); // Returns cached result
    expect(response.body.finalAmount).toBe(60);
  });
});
```

---

## 10. Future Enhancements

1. **GraphQL Subscriptions** - Replace WebSocket with GraphQL for unified data layer
2. **Offline Bid Queue** - Queue bids when offline, sync when reconnected
3. **End-to-End Type Generation** - Generate types from OpenAPI or tRPC
4. **Event Sourcing** - Full bid history as event log for audit
5. **Multi-Region** - Geo-distributed deployment with conflict resolution
6. **Mobile Apps** - React Native with shared business logic

---

## Summary

"I've designed a fullstack online auction platform with:

1. **Shared type definitions** - Consistent contracts between frontend and backend
2. **WebSocket integration** - Real-time bid updates with Redis pub/sub for multi-server support
3. **Optimistic UI updates** - Immediate feedback with server reconciliation
4. **Robust bid processing** - Distributed locking, idempotency, auto-bid resolution
5. **Error handling** - Shared error types with appropriate HTTP status codes
6. **State synchronization** - Zustand store that merges optimistic and server state

The key insight is treating the bid as a multi-phase transaction: client optimistic update, server validation and processing, then real-time broadcast to all watchers. This gives users immediate feedback while maintaining correctness through server-side locks and idempotency."
