export interface User {
  id: string;
  username: string;
  email: string;
  name: string;
  avatar_url: string;
  role: string;
  wallet?: {
    balance: number;
    pendingBalance: number;
  };
}

export interface Transfer {
  id: string;
  sender_id: string;
  receiver_id: string;
  amount: number;
  note: string;
  visibility: 'public' | 'friends' | 'private';
  status: string;
  funding_source: string;
  created_at: string;
  sender_username: string;
  sender_name: string;
  sender_avatar: string;
  receiver_username: string;
  receiver_name: string;
  receiver_avatar: string;
  likes_count?: number;
  comments_count?: number;
  user_liked?: boolean;
}

export interface PaymentRequest {
  id: string;
  requester_id: string;
  requestee_id: string;
  amount: number;
  note: string;
  status: 'pending' | 'paid' | 'declined' | 'cancelled';
  transfer_id?: string;
  reminder_sent_at?: string;
  created_at: string;
  updated_at: string;
  requester_username?: string;
  requester_name?: string;
  requester_avatar?: string;
  requestee_username?: string;
  requestee_name?: string;
  requestee_avatar?: string;
}

export interface PaymentMethod {
  id: string;
  type: 'bank' | 'card' | 'debit_card';
  is_default: boolean;
  name: string;
  last4: string;
  bank_name?: string;
  verified: boolean;
  created_at: string;
}

export interface Friend {
  id: string;
  username: string;
  name: string;
  avatar_url: string;
  friends_since?: string;
}

export interface Cashout {
  id: string;
  user_id: string;
  amount: number;
  fee: number;
  speed: 'instant' | 'standard';
  status: string;
  estimated_arrival: string;
  completed_at?: string;
  created_at: string;
  payment_method_name?: string;
  last4?: string;
}
