import { useState } from 'react';
import type { TradingPair } from '../types';
import { usePortfolioStore } from '../stores/portfolioStore';
import { formatPrice } from '../utils/format';

interface TradeFormProps {
  pair: TradingPair;
  currentPrice: number;
}

type OrderType = 'market' | 'limit' | 'stop';

// Mirror the backend's fee and protection settings (backend/src/config/index.ts).
const TAKER_FEE = 0.002;
const MAKER_FEE = 0.001;
const MARKET_PROTECTION = 0.05;

/** Renders the buy/sell trade form with market/limit/stop types, quantity input, and order summary. */
export function TradeForm({ pair, currentPrice }: TradeFormProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [quantity, setQuantity] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const placeOrder = usePortfolioStore((s) => s.placeOrder);

  const effectivePrice =
    orderType === 'limit' && limitPrice
      ? parseFloat(limitPrice)
      : orderType === 'stop' && stopPrice
        ? parseFloat(stopPrice)
        : currentPrice;
  const qty = parseFloat(quantity || '0');
  const totalCost = qty * effectivePrice;
  // A limit order pays the maker rate if it rests and the taker rate if it crosses.
  const feeLabel = orderType === 'limit' ? 'Fee (0.1–0.2%)' : 'Fee (0.2%)';
  const feeEstimate = totalCost * (orderType === 'limit' ? MAKER_FEE : TAKER_FEE);
  // What the server reserves for a buy: the worst price this order can fill at,
  // plus the taker fee. Anything unspent is released when the order finishes.
  const worstPrice = orderType === 'limit' ? effectivePrice : effectivePrice * (1 + MARKET_PROTECTION);
  const buyHold = qty * worstPrice * (1 + TAKER_FEE);
  const stopHint =
    orderType === 'stop'
      ? side === 'buy'
        ? `Triggers a market buy when the price rises to this level (above ${formatPrice(currentPrice, pair.pricePrecision)})`
        : `Triggers a market sell when the price falls to this level (below ${formatPrice(currentPrice, pair.pricePrecision)})`
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);
    setIsSubmitting(true);

    try {
      const result = await placeOrder({
        tradingPairId: pair.id,
        side,
        orderType,
        quantity,
        price: orderType === 'limit' ? limitPrice : undefined,
        stopPrice: orderType === 'stop' ? stopPrice : undefined,
      });

      const outcome: Record<string, string> = {
        filled: 'Order filled',
        partially_filled: 'Order partially filled; the rest is on the book',
        open: orderType === 'stop' ? 'Stop order armed' : 'Order placed on the book',
        cancelled:
          parseFloat(result.filledQuantity) > 0
            ? 'Partially filled; unfilled remainder cancelled'
            : 'No liquidity within 5% of the price; order cancelled',
      };
      setMessage({
        type: result.status === 'cancelled' && parseFloat(result.filledQuantity) === 0 ? 'error' : 'success',
        text: outcome[result.status] ?? `Order ${result.status}`,
      });
      setQuantity('');
      setLimitPrice('');
      setStopPrice('');
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Order failed',
      });
    }

    setIsSubmitting(false);
  };

  return (
    <div>
      {/* Buy/Sell tabs */}
      <div className="flex rounded-lg overflow-hidden mb-4 border border-cb-border">
        <button
          onClick={() => setSide('buy')}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
            side === 'buy'
              ? 'bg-cb-green text-white'
              : 'bg-cb-surface text-cb-text-secondary hover:text-cb-text'
          }`}
        >
          Buy
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`flex-1 py-2.5 text-sm font-semibold transition-colors ${
            side === 'sell'
              ? 'bg-cb-red text-white'
              : 'bg-cb-surface text-cb-text-secondary hover:text-cb-text'
          }`}
        >
          Sell
        </button>
      </div>

      {/* Order type toggle */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => setOrderType('market')}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            orderType === 'market'
              ? 'bg-cb-primary text-white'
              : 'bg-cb-surface text-cb-text-secondary hover:text-cb-text'
          }`}
        >
          Market
        </button>
        <button
          onClick={() => setOrderType('limit')}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            orderType === 'limit'
              ? 'bg-cb-primary text-white'
              : 'bg-cb-surface text-cb-text-secondary hover:text-cb-text'
          }`}
        >
          Limit
        </button>
        <button
          onClick={() => setOrderType('stop')}
          className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            orderType === 'stop'
              ? 'bg-cb-primary text-white'
              : 'bg-cb-surface text-cb-text-secondary hover:text-cb-text'
          }`}
        >
          Stop
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Limit price */}
        {orderType === 'limit' && (
          <div>
            <label className="block text-xs text-cb-text-secondary mb-1">
              Limit Price ({pair.quoteCurrency})
            </label>
            <input
              type="number"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={formatPrice(currentPrice, pair.pricePrecision)}
              step="any"
              className="w-full bg-cb-surface border border-cb-border rounded-lg px-3 py-2.5 text-sm text-cb-text focus:outline-none focus:border-cb-primary"
              required
            />
          </div>
        )}

        {/* Stop price */}
        {orderType === 'stop' && (
          <div>
            <label className="block text-xs text-cb-text-secondary mb-1">
              Stop Price ({pair.quoteCurrency})
            </label>
            <input
              type="number"
              value={stopPrice}
              onChange={(e) => setStopPrice(e.target.value)}
              placeholder={formatPrice(currentPrice, pair.pricePrecision)}
              step="any"
              className="w-full bg-cb-surface border border-cb-border rounded-lg px-3 py-2.5 text-sm text-cb-text focus:outline-none focus:border-cb-primary"
              required
            />
            <p className="text-[11px] text-cb-text-secondary mt-1">{stopHint}</p>
          </div>
        )}

        {/* Quantity */}
        <div>
          <label className="block text-xs text-cb-text-secondary mb-1">
            Amount ({pair.baseCurrency})
          </label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0.00"
            step="any"
            min={pair.minOrderSize}
            max={pair.maxOrderSize}
            className="w-full bg-cb-surface border border-cb-border rounded-lg px-3 py-2.5 text-sm text-cb-text focus:outline-none focus:border-cb-primary"
            required
          />
        </div>

        {/* Quick amount buttons */}
        <div className="flex gap-2">
          {[0.001, 0.01, 0.1, 1].map((amt) => (
            <button
              key={amt}
              type="button"
              onClick={() => setQuantity(amt.toString())}
              className="flex-1 bg-cb-surface border border-cb-border rounded px-2 py-1 text-xs text-cb-text-secondary hover:text-cb-text hover:border-cb-primary/50 transition-colors"
            >
              {amt}
            </button>
          ))}
        </div>

        {/* Order summary */}
        <div className="bg-cb-surface rounded-lg p-3 space-y-2 text-xs">
          <div className="flex justify-between">
            <span className="text-cb-text-secondary">
              {orderType === 'market' ? 'Market' : orderType === 'limit' ? 'Limit' : 'Stop'} Price
            </span>
            <span>
              ${formatPrice(effectivePrice, pair.pricePrecision)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-cb-text-secondary">Est. Total</span>
            <span className="font-medium">
              ${isNaN(totalCost) ? '0.00' : formatPrice(totalCost, 2)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-cb-text-secondary">{feeLabel}</span>
            <span>
              ${isNaN(feeEstimate) ? '0.00' : formatPrice(feeEstimate, 2)}
            </span>
          </div>
          {side === 'buy' && (
            <div className="flex justify-between" title="Worst-case price plus fee. Unspent funds are released when the order finishes.">
              <span className="text-cb-text-secondary">Funds held</span>
              <span>${isNaN(buyHold) ? '0.00' : formatPrice(buyHold, 2)}</span>
            </div>
          )}
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={isSubmitting || !quantity}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50 ${
            side === 'buy'
              ? 'bg-cb-green hover:bg-cb-green/90 text-white'
              : 'bg-cb-red hover:bg-cb-red/90 text-white'
          }`}
        >
          {isSubmitting
            ? 'Processing...'
            : `${side === 'buy' ? 'Buy' : 'Sell'} ${pair.baseCurrency}`}
        </button>
      </form>

      {/* Message */}
      {message && (
        <div
          className={`mt-3 p-2 rounded text-xs text-center ${
            message.type === 'success'
              ? 'bg-cb-green/10 text-cb-green'
              : 'bg-cb-red/10 text-cb-red'
          }`}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
