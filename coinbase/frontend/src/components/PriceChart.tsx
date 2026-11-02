import { useEffect, useRef } from 'react';
import {
  createChart,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../types';

interface PriceChartProps {
  candles: Candle[];
  symbol: string;
}

/**
 * Renders a TradingView lightweight candlestick chart with responsive resizing.
 * The chart is created once; new candles replace the series data without
 * destroying the chart, so the user's zoom and scroll survive each refresh.
 * The view is fitted only when the symbol changes.
 */
export function PriceChart({ candles, symbol }: PriceChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const fittedSymbolRef = useRef<string | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: 400,
      layout: {
        background: { color: '#16171A' },
        textColor: '#8A919E',
        fontSize: 12,
      },
      grid: {
        vertLines: { color: '#2C2D33' },
        horzLines: { color: '#2C2D33' },
      },
      crosshair: {
        mode: 0,
        vertLine: {
          color: '#8A919E',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1E2026',
        },
        horzLine: {
          color: '#8A919E',
          width: 1,
          style: 2,
          labelBackgroundColor: '#1E2026',
        },
      },
      rightPriceScale: {
        borderColor: '#2C2D33',
        scaleMargins: {
          top: 0.1,
          bottom: 0.1,
        },
      },
      timeScale: {
        borderColor: '#2C2D33',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: '#00C087',
      downColor: '#FF3B30',
      borderDownColor: '#FF3B30',
      borderUpColor: '#00C087',
      wickDownColor: '#FF3B30',
      wickUpColor: '#00C087',
    });

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      fittedSymbolRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );
    if (candles.length > 0 && fittedSymbolRef.current !== symbol) {
      chartRef.current?.timeScale().fitContent();
      fittedSymbolRef.current = symbol;
    }
  }, [candles, symbol]);

  return (
    <div ref={chartContainerRef} className="w-full">
      {candles.length === 0 && (
        <div className="flex items-center justify-center h-[400px] text-cb-text-secondary">
          <div className="text-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-cb-primary mx-auto mb-2" />
            <p className="text-sm">Loading chart data...</p>
          </div>
        </div>
      )}
    </div>
  );
}
