import { useState } from 'react';
import { useQuoteStore } from '../stores/quoteStore';
import { usePortfolioStore } from '../stores/portfolioStore';

interface TradeFormProps {
  symbol: string;
  onSuccess?: () => void;
  onClose?: () => void;
}

export function TradeForm({ symbol, onSuccess, onClose }: TradeFormProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [quantity, setQuantity] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const quote = useQuoteStore((state) => state.getQuote(symbol));
  const { portfolio, placeOrder } = usePortfolioStore();

  const estimatedPrice = orderType === 'limit' && limitPrice
    ? parseFloat(limitPrice)
    : side === 'buy'
      ? quote?.ask ?? 0
      : quote?.bid ?? 0;

  const estimatedTotal = parseFloat(quantity || '0') * estimatedPrice;

  const position = portfolio?.holdings.find((h) => h.symbol === symbol);
  const availableShares = position?.quantity ?? 0;
  const buyingPower = portfolio?.buyingPower ?? 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const qty = parseFloat(quantity);
    if (!qty || qty <= 0) {
      setError('Please enter a valid quantity');
      return;
    }

    if (orderType === 'limit' && (!limitPrice || parseFloat(limitPrice) <= 0)) {
      setError('Please enter a valid limit price');
      return;
    }

    setIsSubmitting(true);

    try {
      const order = await placeOrder({
        symbol,
        side,
        orderType,
        quantity: qty,
        limitPrice: orderType === 'limit' ? parseFloat(limitPrice) : undefined,
      });

      setSuccess(
        order.status === 'filled'
          ? `Order filled at $${order.avg_fill_price?.toFixed(2)}`
          : 'Order placed successfully'
      );
      setQuantity('');
      setLimitPrice('');

      if (onSuccess) {
        setTimeout(onSuccess, 1500);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-robinhood-gray-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-white">Trade {symbol}</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-robinhood-gray-400 hover:text-white"
          >
            x
          </button>
        )}
      </div>

      {/* Buy/Sell Toggle */}
      <div className="flex mb-6">
        <button
          type="button"
          onClick={() => setSide('buy')}
          className={`flex-1 py-3 text-center font-medium rounded-l-lg transition-colors ${
            side === 'buy'
              ? 'bg-robinhood-green text-black'
              : 'bg-robinhood-gray-700 text-robinhood-gray-300 hover:bg-robinhood-gray-600'
          }`}
        >
          Buy
        </button>
        <button
          type="button"
          onClick={() => setSide('sell')}
          className={`flex-1 py-3 text-center font-medium rounded-r-lg transition-colors ${
            side === 'sell'
              ? 'bg-robinhood-red text-white'
              : 'bg-robinhood-gray-700 text-robinhood-gray-300 hover:bg-robinhood-gray-600'
          }`}
        >
          Sell
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        {/* Order Type */}
        <div className="mb-4">
          <label className="block text-sm text-robinhood-gray-400 mb-2">
            Order Type
          </label>
          <select
            value={orderType}
            onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
            className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
          >
            <option value="market">Market Order</option>
            <option value="limit">Limit Order</option>
          </select>
        </div>

        {/* Quantity */}
        <div className="mb-4">
          <label className="block text-sm text-robinhood-gray-400 mb-2">
            Shares
          </label>
          <input
            type="number"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
            min="0.000001"
            step="any"
            className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
          />
        </div>

        {/* Limit Price */}
        {orderType === 'limit' && (
          <div className="mb-4">
            <label className="block text-sm text-robinhood-gray-400 mb-2">
              Limit Price
            </label>
            <input
              type="number"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              placeholder={quote?.last.toFixed(2) || '0.00'}
              min="0.01"
              step="0.01"
              className="w-full bg-robinhood-gray-700 text-white rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-robinhood-green"
            />
          </div>
        )}

        {/* Order Summary */}
        <div className="bg-robinhood-gray-700 rounded-lg p-4 mb-6">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-robinhood-gray-400">Market Price</span>
            <span className="text-white">
              ${side === 'buy' ? quote?.ask.toFixed(2) : quote?.bid.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-between text-sm mb-2">
            <span className="text-robinhood-gray-400">Estimated Total</span>
            <span className="text-white">${estimatedTotal.toFixed(2)}</span>
          </div>
          <div className="border-t border-robinhood-gray-600 my-2" />
          <div className="flex justify-between text-sm">
            <span className="text-robinhood-gray-400">
              {side === 'buy' ? 'Buying Power' : 'Shares Available'}
            </span>
            <span className="text-white">
              {side === 'buy'
                ? `$${buyingPower.toFixed(2)}`
                : `${availableShares.toFixed(6)}`}
            </span>
          </div>
        </div>

        {/* Error/Success Messages */}
        {error && (
          <div className="bg-robinhood-red bg-opacity-20 text-robinhood-red rounded-lg p-3 mb-4 text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-robinhood-green bg-opacity-20 text-robinhood-green rounded-lg p-3 mb-4 text-sm">
            {success}
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isSubmitting || !quantity}
          className={`w-full py-4 rounded-full font-semibold transition-colors ${
            side === 'buy'
              ? 'bg-robinhood-green text-black hover:bg-opacity-90'
              : 'bg-robinhood-red text-white hover:bg-opacity-90'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {isSubmitting
            ? 'Processing...'
            : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol}`}
        </button>
      </form>
    </div>
  );
}
