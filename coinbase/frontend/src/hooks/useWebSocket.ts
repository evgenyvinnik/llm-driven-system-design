import { useEffect, useRef } from 'react';
import { wsClient } from '../services/websocket';
import { useMarketStore } from '../stores/marketStore';
import { useAuthStore } from '../stores/authStore';
import { usePortfolioStore } from '../stores/portfolioStore';
import type { PriceData } from '../types';

/**
 * Connects to the WebSocket server, streams prices into the market store, and
 * refreshes orders and balances when the server pushes an order update.
 *
 * Handlers are registered on every effect run and removed on cleanup, so React
 * StrictMode's setup → cleanup → setup cycle ends with exactly one live
 * handler. (A "connected" ref that skipped the second setup left the price
 * handler unregistered in development.) connect() itself is idempotent.
 */
export function useWebSocket(): void {
  const updatePairPrices = useMarketStore((s) => s.updatePairPrices);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const fetchOrders = usePortfolioStore((s) => s.fetchOrders);
  const fetchWallets = usePortfolioStore((s) => s.fetchWallets);
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    wsClient.connect();
    const unsubscribe = wsClient.onPriceUpdate((prices: Record<string, PriceData>) => {
      updatePairPrices(prices);
    });
    return unsubscribe;
  }, [updatePairPrices]);

  // The server binds the private channel from the session cookie at upgrade
  // time, so a login or logout needs a fresh socket.
  useEffect(() => {
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      wsClient.reconnect();
    }
    previousUserId.current = userId;
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    return wsClient.onMessage('order_update', () => {
      fetchOrders();
      fetchWallets();
    });
  }, [userId, fetchOrders, fetchWallets]);
}

/** Subscribes to ticker updates for a specific trading pair symbol. */
export function useTickerSubscription(symbol: string): void {
  useEffect(() => {
    if (!symbol) return;

    wsClient.subscribe([`ticker:${symbol}`]);

    return () => {
      wsClient.unsubscribe([`ticker:${symbol}`]);
    };
  }, [symbol]);
}
