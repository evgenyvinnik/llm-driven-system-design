import type { Request } from 'express';

// User types
export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
  password_hash?: string;
  created_at?: Date;
}

// Auction types
export interface Auction {
  id: string;
  seller_id: string;
  title: string;
  description?: string;
  image_url?: string;
  starting_price: number;
  current_price: number;
  reserve_price?: number;
  bid_increment: number;
  start_time: Date;
  end_time: Date;
  snipe_protection_minutes: number;
  status: 'active' | 'ended' | 'cancelled';
  winner_id?: string;
  winning_bid_id?: string;
  version: number;
  created_at: Date;
  seller_name?: string;
  bid_count?: number;
}

// Bid types
export interface Bid {
  id: string;
  auction_id: string;
  bidder_id: string;
  amount: number;
  is_auto_bid: boolean;
  sequence_num: number;
  created_at: Date;
  bidder_name?: string;
}

// Auto-bid types
export interface AutoBid {
  id: string;
  auction_id: string;
  bidder_id: string;
  max_amount: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

// Notification types
export interface Notification {
  id: string;
  user_id: string;
  auction_id?: string;
  type: 'outbid' | 'auction_won' | 'auction_sold' | 'auction_lost' | 'reserve_not_met' | 'no_bids';
  message: string;
  is_read: boolean;
  created_at: Date;
  auction_title?: string;
}

// Extended Express Request with user
export interface AuthenticatedRequest extends Request {
  user?: User;
  sessionToken?: string;
}

// Lock type for distributed locking
export interface Lock {
  lockKey: string;
  lockValue: string;
  startTime: number;
}

// Bid event for logging
export interface BidEventData {
  auctionId: string;
  bidderId: string;
  amount: number;
  isAutoBid?: boolean;
  durationMs?: number;
  idempotencyKey?: string;
}

// Auction event for logging
export interface AuctionEventData {
  action: string;
  auctionId: string;
  sellerId?: string;
  winnerId?: string;
  finalPrice?: number;
  durationMs?: number;
}

// Cache event for logging
export interface CacheEventData {
  action: string;
  key: string;
  hit?: boolean;
  durationMs?: number;
}

// Payment types
export interface PaymentData {
  auctionId: string;
  winnerId: string;
  amount: number;
}

export interface PaymentResult {
  success: boolean;
  transactionId?: string;
  auctionId: string;
  amount?: number;
  timestamp?: string;
  queued?: boolean;
  message?: string;
  retryAt?: string;
}

// Escrow types
export interface EscrowHoldData {
  auctionId: string;
  bidderId: string;
  amount: number;
}

export interface EscrowReleaseData {
  escrowId: string;
  auctionId: string;
  releaseTo: string;
}

export interface EscrowResult {
  success: boolean;
  escrowId?: string;
  auctionId?: string;
  amount?: number;
  status?: string;
  timestamp?: string;
  queued?: boolean;
  message?: string;
  releasedTo?: string;
}

// Rate limit result
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;
}

// Health check types
export interface HealthStatus {
  status: 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
  latency?: string;
  error?: string;
}

// WebSocket message types
export interface WebSocketMessage {
  type: string;
  auction_id?: string;
  timestamp?: number;
  [key: string]: unknown;
}

// Bid update for publishing
export interface BidUpdate {
  type: 'new_bid' | 'auction_ended';
  auction_id: string;
  current_price?: number;
  bidder_id?: string;
  bid_amount?: number;
  is_auto_bid?: boolean;
  winner_id?: string;
  final_price?: number;
  timestamp: string;
}

// Current bid cache info
export interface CurrentBidInfo {
  amount: number;
  bidder_id: string;
  timestamp: string;
}

// Idempotent bid result
export interface IdempotentBidResult {
  bid?: Bid;
  current_price: number;
  is_winning: boolean;
}

// Circuit breaker health
export interface CircuitBreakerHealth {
  payment: {
    state: string;
    stats: unknown;
  };
  escrowHold: {
    state: string;
    stats: unknown;
  };
  escrowRelease: {
    state: string;
    stats: unknown;
  };
}

// Connection stats
export interface ConnectionStats {
  connectedClients: number;
  totalSubscriptions: number;
  activeAuctions: number;
}

// WebSocket with custom properties
export interface AuctionWebSocket extends WebSocket {
  userId?: string;
  username?: string;
}
