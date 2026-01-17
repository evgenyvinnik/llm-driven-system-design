/**
 * Quote display components for showing real-time stock prices.
 * Provides visual feedback (flashing) when prices change.
 */

import { useEffect, useRef, useState } from 'react';
import type { Quote } from '../types';

/**
 * Props for the PriceDisplay component.
 */
interface PriceDisplayProps {
  quote: Quote | undefined;
  showChange?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Displays a stock price with optional change indicator.
 * Flashes green/red when price moves up/down.
 * @param quote - Quote data to display
 * @param showChange - Whether to show price change (default: true)
 * @param size - Text size variant (sm, md, lg)
 */
export function PriceDisplay({ quote, showChange = true, size = 'md' }: PriceDisplayProps) {
  const [flashClass, setFlashClass] = useState('');
  const prevPriceRef = useRef<number | null>(null);

  useEffect(() => {
    if (quote && prevPriceRef.current !== null) {
      if (quote.last > prevPriceRef.current) {
        setFlashClass('flash-green');
      } else if (quote.last < prevPriceRef.current) {
        setFlashClass('flash-red');
      }

      const timer = setTimeout(() => setFlashClass(''), 300);
      return () => clearTimeout(timer);
    }
    if (quote) {
      prevPriceRef.current = quote.last;
    }
  }, [quote?.last]);

  if (!quote) {
    return <span className="text-robinhood-gray-400">--</span>;
  }

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-2xl font-semibold',
  };

  const changeColor = quote.change >= 0 ? 'text-robinhood-green' : 'text-robinhood-red';

  return (
    <div className={`${flashClass} rounded transition-colors`}>
      <span className={`${sizeClasses[size]} text-white`}>
        ${quote.last.toFixed(2)}
      </span>
      {showChange && (
        <span className={`${sizeClasses[size]} ${changeColor} ml-2`}>
          {quote.change >= 0 ? '+' : ''}
          {quote.change.toFixed(2)} ({quote.changePercent >= 0 ? '+' : ''}
          {quote.changePercent.toFixed(2)}%)
        </span>
      )}
    </div>
  );
}

/**
 * Props for the QuoteCard component.
 */
interface QuoteCardProps {
  symbol: string;
  name?: string;
  quote: Quote | undefined;
  onClick?: () => void;
}

/**
 * Card component displaying stock symbol, name, price, and change.
 * Used in stock lists and watchlists.
 * @param symbol - Stock ticker symbol
 * @param name - Company name (optional)
 * @param quote - Quote data to display
 * @param onClick - Optional click handler
 */
export function QuoteCard({ symbol, name, quote, onClick }: QuoteCardProps) {
  const changeColor = (quote?.change ?? 0) >= 0 ? 'text-robinhood-green' : 'text-robinhood-red';

  return (
    <div
      onClick={onClick}
      className={`bg-robinhood-gray-800 rounded-lg p-4 hover:bg-robinhood-gray-700 transition-colors ${
        onClick ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold text-white">{symbol}</h3>
          {name && (
            <p className="text-sm text-robinhood-gray-400 truncate max-w-[150px]">
              {name}
            </p>
          )}
        </div>
        <div className="text-right">
          {quote ? (
            <>
              <p className="font-semibold text-white">${quote.last.toFixed(2)}</p>
              <p className={`text-sm ${changeColor}`}>
                {quote.change >= 0 ? '+' : ''}
                {quote.changePercent.toFixed(2)}%
              </p>
            </>
          ) : (
            <p className="text-robinhood-gray-400">--</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the MiniChart component.
 */
interface MiniChartProps {
  positive: boolean;
}

/**
 * Simple SVG mini chart placeholder.
 * Shows an upward or downward trend line based on positive prop.
 * @param positive - Whether to show upward (green) or downward (red) trend
 */
export function MiniChart({ positive }: MiniChartProps) {
  // Simple placeholder for a mini chart
  const color = positive ? '#00C805' : '#FF5000';

  return (
    <svg viewBox="0 0 100 30" className="w-24 h-8">
      <path
        d={
          positive
            ? 'M 0 25 Q 25 20 50 15 T 100 5'
            : 'M 0 5 Q 25 10 50 15 T 100 25'
        }
        fill="none"
        stroke={color}
        strokeWidth="2"
      />
    </svg>
  );
}
