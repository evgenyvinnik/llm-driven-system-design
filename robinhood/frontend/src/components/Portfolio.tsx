/**
 * Portfolio display components for showing account summary and holdings.
 * Integrates with portfolio store and real-time quote updates.
 */

import { useEffect, useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { usePortfolioStore } from '../stores/portfolioStore';
import { useQuoteStore } from '../stores/quoteStore';
import { MiniChart } from './QuoteDisplay';

/**
 * Portfolio summary card showing total equity, gains/losses, and buying power.
 * Refreshes data every 10 seconds to keep values current.
 */
export function PortfolioSummary() {
  const { portfolio, fetchPortfolio, isLoading } = usePortfolioStore();

  useEffect(() => {
    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 10000);
    return () => clearInterval(interval);
  }, [fetchPortfolio]);

  if (isLoading && !portfolio) {
    return (
      <div className="bg-robinhood-gray-800 rounded-lg p-6 animate-pulse">
        <div className="h-8 bg-robinhood-gray-700 rounded w-1/3 mb-4" />
        <div className="h-6 bg-robinhood-gray-700 rounded w-1/4" />
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="bg-robinhood-gray-800 rounded-lg p-6">
        <p className="text-robinhood-gray-400">Unable to load portfolio</p>
      </div>
    );
  }

  const totalEquity = portfolio.totalValue + portfolio.buyingPower;
  const isPositive = portfolio.dayChange >= 0;
  const changeColor = isPositive ? 'text-robinhood-green' : 'text-robinhood-red';

  return (
    <div className="bg-robinhood-gray-800 rounded-lg p-6">
      <div className="mb-6">
        <h2 className="text-robinhood-gray-400 text-sm mb-1">Total Equity</h2>
        <p className="text-3xl font-bold text-white">${totalEquity.toFixed(2)}</p>
        <p className={`${changeColor} text-lg`}>
          {isPositive ? '+' : ''}${portfolio.dayChange.toFixed(2)} (
          {isPositive ? '+' : ''}
          {portfolio.dayChangePercent.toFixed(2)}%) today
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-robinhood-gray-700 rounded-lg p-4">
          <p className="text-robinhood-gray-400 text-sm mb-1">Portfolio Value</p>
          <p className="text-xl font-semibold text-white">
            ${portfolio.totalValue.toFixed(2)}
          </p>
          <p className={`text-sm ${portfolio.totalGainLoss >= 0 ? 'text-robinhood-green' : 'text-robinhood-red'}`}>
            {portfolio.totalGainLoss >= 0 ? '+' : ''}
            ${portfolio.totalGainLoss.toFixed(2)} ({portfolio.totalGainLossPercent.toFixed(2)}%)
          </p>
        </div>
        <div className="bg-robinhood-gray-700 rounded-lg p-4">
          <p className="text-robinhood-gray-400 text-sm mb-1">Buying Power</p>
          <p className="text-xl font-semibold text-white">
            ${portfolio.buyingPower.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Holdings list showing all stock positions with real-time prices.
 * Subscribes to WebSocket updates for held symbols.
 * Links to individual stock detail pages.
 */
export function HoldingsList() {
  const { portfolio } = usePortfolioStore();
  const { quotes, subscribe, unsubscribe } = useQuoteStore();

  const symbols = useMemo(
    () => portfolio?.holdings.map((h) => h.symbol) ?? [],
    [portfolio?.holdings]
  );

  useEffect(() => {
    if (symbols.length > 0) {
      subscribe(symbols);
      return () => unsubscribe(symbols);
    }
  }, [symbols, subscribe, unsubscribe]);

  if (!portfolio || portfolio.holdings.length === 0) {
    return (
      <div className="bg-robinhood-gray-800 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-4">Holdings</h3>
        <p className="text-robinhood-gray-400">No positions yet. Start trading!</p>
        <Link
          to="/stocks"
          className="inline-block mt-4 text-robinhood-green hover:underline"
        >
          Browse stocks
        </Link>
      </div>
    );
  }

  return (
    <div className="bg-robinhood-gray-800 rounded-lg p-6">
      <h3 className="text-lg font-semibold text-white mb-4">Holdings</h3>
      <div className="space-y-4">
        {portfolio.holdings.map((holding) => {
          const quote = quotes.get(holding.symbol);
          const currentPrice = quote?.last ?? holding.currentPrice;
          const isPositive = (quote?.change ?? 0) >= 0;

          return (
            <Link
              key={holding.symbol}
              to="/stock/$symbol"
              params={{ symbol: holding.symbol }}
              className="flex items-center justify-between p-4 bg-robinhood-gray-700 rounded-lg hover:bg-robinhood-gray-600 transition-colors"
            >
              <div className="flex items-center space-x-4">
                <div>
                  <p className="font-semibold text-white">{holding.symbol}</p>
                  <p className="text-sm text-robinhood-gray-400">
                    {holding.quantity.toFixed(holding.quantity % 1 === 0 ? 0 : 4)} shares
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-4">
                <MiniChart positive={isPositive} />
                <div className="text-right">
                  <p className="font-semibold text-white">
                    ${(currentPrice * holding.quantity).toFixed(2)}
                  </p>
                  <p
                    className={`text-sm ${
                      holding.gainLoss >= 0 ? 'text-robinhood-green' : 'text-robinhood-red'
                    }`}
                  >
                    {holding.gainLoss >= 0 ? '+' : ''}
                    {holding.gainLossPercent.toFixed(2)}%
                  </p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
