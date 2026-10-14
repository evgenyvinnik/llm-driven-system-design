/**
 * Represents a user account in the auction system.
 * Users can be either regular bidders/sellers or administrators.
 */
export interface User {
  /** Unique user identifier (UUID) */
  id: string;
  /** Display name shown in bids and auction listings */
  username: string;
  /** Email address used for login and notifications */
  email: string;
  /** User permission level - admins can manage platform */
  role: 'user' | 'admin';
}

/**
 * Represents an auction listing with all its properties.
 * Core entity of the system - items for sale with bidding.
 */
export interface Auction {
  /** Unique auction identifier (UUID) */
  id: string;
  /** User ID of the auction creator */
  seller_id: string;
  /** Display name of the seller */
  seller_name: string;
  /** Item title/name */
  title: string;
  /** Optional detailed item description */
  description: string | null;
  /** URL to item image (stored in object storage) */
  image_url: string | null;
  /** Initial asking price (decimal string) */
  starting_price: string;
  /** Current highest bid price (decimal string) */
  current_price: string;
  /** Minimum price to sell - hidden from bidders (decimal string) */
  reserve_price: string | null;
  /** Minimum increment for new bids (decimal string) */
  bid_increment: string;
  /** When auction becomes active (ISO date string) */
  start_time: string;
  /** When auction ends (ISO date string) */
  end_time: string;
  /** Current auction lifecycle state */
  status: 'pending' | 'active' | 'ended' | 'cancelled';
  /** User ID of winning bidder (null if no winner yet) */
  winner_id: string | null;
  /** Bid ID of the winning bid (null if no winner yet) */
  winning_bid_id: string | null;
  /** Minutes to extend auction if bid placed near end (anti-sniping) */
  snipe_protection_minutes: number;
  /** When auction was created (ISO date string) */
  created_at: string;
  /** Last modification timestamp (ISO date string) */
  updated_at: string;
  /** Optimistic locking version for concurrent bid handling */
  version: number;
  /** Total number of bids placed (optional, included in listings) */
  bid_count?: number;
}

/**
 * Represents a single bid placed on an auction.
 * Bids are immutable once placed.
 */
export interface Bid {
  /** Unique bid identifier (UUID) */
  id: string;
  /** Auction this bid is for */
  auction_id: string;
  /** User who placed the bid */
  bidder_id: string;
  /** Display name of the bidder */
  bidder_name: string;
  /** Bid amount (decimal string) */
  amount: string;
  /** True if this bid was placed by the auto-bidding system */
  is_auto_bid: boolean;
  /** When bid was placed (ISO date string) */
  created_at: string;
  /** Sequential bid number for ordering */
  sequence_num: number;
}

/**
 * Configuration for automatic bidding on an auction.
 * System places bids on user's behalf up to max_amount.
 */
export interface AutoBid {
  /** Unique auto-bid configuration ID (UUID) */
  id: string;
  /** Target auction */
  auction_id: string;
  /** User who configured auto-bidding */
  bidder_id: string;
  /** Maximum amount system will bid (decimal string) */
  max_amount: string;
  /** Whether auto-bidding is currently active */
  is_active: boolean;
  /** When configuration was created (ISO date string) */
  created_at: string;
  /** Last modification timestamp (ISO date string) */
  updated_at: string;
}

/**
 * In-app notification for auction events.
 * Notifies users of outbids, wins, sales, etc.
 */
export interface Notification {
  /** Unique notification ID (UUID) */
  id: string;
  /** Recipient user */
  user_id: string;
  /** Related auction (null for system notifications) */
  auction_id: string | null;
  /** Notification category (outbid, auction_won, auction_sold, etc.) */
  type: string;
  /** Human-readable notification text */
  message: string;
  /** True if user has viewed/dismissed this notification */
  is_read: boolean;
  /** When notification was created (ISO date string) */
  created_at: string;
  /** Title of related auction (optional, for display) */
  auction_title?: string;
}

/**
 * Full auction details with related data.
 * Returned by the auction detail endpoint.
 */
export interface AuctionDetail {
  /** The auction entity */
  auction: Auction;
  /** Bid history ordered by amount descending */
  bids: Bid[];
  /** Current user's auto-bid config or null */
  userAutoBid: AutoBid | null;
  /** Whether current user is watching this auction */
  isWatching: boolean;
}

/**
 * Generic paginated response wrapper.
 * Used for auction listings with pagination.
 */
export interface PaginatedResponse<T> {
  /** Array of items for current page */
  auctions: T[];
  /** Pagination metadata */
  pagination: {
    /** Current page number (1-indexed) */
    page: number;
    /** Items per page */
    limit: number;
    /** Total items across all pages */
    total: number;
    /** Total number of pages */
    pages: number;
  };
}

/**
 * WebSocket message format for real-time updates.
 * All fields except 'type' are optional depending on message type.
 */
export interface WebSocketMessage {
  /** Message type determining which fields are present */
  type: 'connected' | 'subscribed' | 'unsubscribed' | 'new_bid' | 'auction_ended' | 'pong' | 'error';
  /** Auction ID for bid/auction events */
  auction_id?: string;
  /** Current auction price after a new bid */
  current_price?: number;
  /** ID of user who placed the bid */
  bidder_id?: string;
  /** Amount of the new bid */
  bid_amount?: number;
  /** Whether this was an automatic bid */
  is_auto_bid?: boolean;
  /** Winner ID when auction ends */
  winner_id?: string;
  /** Final auction price when ended */
  final_price?: number;
  /** Server timestamp of the event */
  timestamp?: string;
  /** Whether connection is authenticated */
  authenticated?: boolean;
  /**
   * Auction version after this event. It increases by one on every price
   * change, close and cancel, so the client can drop stale events and detect
   * missed ones (a jump of more than one means "refetch").
   */
  version?: number;
  /** End time after this bid (moves when snipe protection extends the auction) */
  end_time?: string;
  /** True when this bid extended the auction */
  extended?: boolean;
  /** Current leader after this bid */
  leader_id?: string;
  /** Bid rows written by this event, so the history updates without a refetch */
  bids?: Bid[];
  /** How the auction ended: sold, reserve_not_met, no_bids or cancelled */
  outcome?: string;
  /** Error or info message */
  message?: string;
}
