export interface User {
  id: string;
  username: string;
  email: string;
  role: 'user' | 'admin';
}

export interface Auction {
  id: string;
  seller_id: string;
  seller_name: string;
  title: string;
  description: string | null;
  image_url: string | null;
  starting_price: string;
  current_price: string;
  reserve_price: string | null;
  bid_increment: string;
  start_time: string;
  end_time: string;
  status: 'pending' | 'active' | 'ended' | 'cancelled';
  winner_id: string | null;
  winning_bid_id: string | null;
  snipe_protection_minutes: number;
  created_at: string;
  updated_at: string;
  version: number;
  bid_count?: number;
}

export interface Bid {
  id: string;
  auction_id: string;
  bidder_id: string;
  bidder_name: string;
  amount: string;
  is_auto_bid: boolean;
  created_at: string;
  sequence_num: number;
}

export interface AutoBid {
  id: string;
  auction_id: string;
  bidder_id: string;
  max_amount: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  auction_id: string | null;
  type: string;
  message: string;
  is_read: boolean;
  created_at: string;
  auction_title?: string;
}

export interface AuctionDetail {
  auction: Auction;
  bids: Bid[];
  userAutoBid: AutoBid | null;
  isWatching: boolean;
}

export interface PaginatedResponse<T> {
  auctions: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface WebSocketMessage {
  type: 'connected' | 'subscribed' | 'unsubscribed' | 'new_bid' | 'auction_ended' | 'pong' | 'error';
  auction_id?: string;
  current_price?: number;
  bidder_id?: string;
  bid_amount?: number;
  is_auto_bid?: boolean;
  winner_id?: string;
  final_price?: number;
  timestamp?: string;
  authenticated?: boolean;
  message?: string;
}
