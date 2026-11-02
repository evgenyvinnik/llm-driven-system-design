export interface TradingPair {
  id: string;
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  pricePrecision: number;
  quantityPrecision: number;
  minOrderSize: string;
  maxOrderSize: string;
  isActive: boolean;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
  total: number;
}

export interface Order {
  id: string;
  tradingPairId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit' | 'stop';
  quantity: number;
  price: number | null;
  stopPrice: string | null;
  filledQuantity: number;
  avgFillPrice: number | null;
  status: 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled';
  createdAt: string;
}

export interface Wallet {
  currencyId: string;
  balance: number;
  reservedBalance: number;
  available: number;
  valueUsd: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface User {
  id: string;
  username: string;
  email: string;
  displayName: string;
  isVerified: boolean;
  createdAt: string;
}

export interface PortfolioHolding {
  currencyId: string;
  currencyName: string;
  balance: string;
  reservedBalance: string;
  available: string;
  valueUsd: string;
  isFiat: boolean;
  allocation: string;
}

export interface Currency {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  isFiat: boolean;
  isActive: boolean;
}

export interface PriceData {
  price: number;
  change24h: number;
  changePercent24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}
