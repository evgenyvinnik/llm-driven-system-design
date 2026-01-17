import { useEffect, useRef } from 'react';
import type { SSEMessage } from '../types';
import { useTrendingStore } from '../stores/trendingStore';

export function useSSE() {
  const eventSourceRef = useRef<EventSource | null>(null);
  const { setTrending, setConnected } = useTrendingStore();

  useEffect(() => {
    const connect = () => {
      const eventSource = new EventSource('/api/sse/trending');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('SSE connected');
        setConnected(true);
      };

      eventSource.onmessage = (event) => {
        try {
          const data: SSEMessage = JSON.parse(event.data);

          if (data.type === 'connected') {
            console.log('SSE connection confirmed:', data.message);
          } else if (data.type === 'trending-update' && data.trending) {
            setTrending(data.trending);
          }
        } catch (error) {
          console.error('Error parsing SSE message:', error);
        }
      };

      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        setConnected(false);
        eventSource.close();

        // Reconnect after delay
        setTimeout(connect, 5000);
      };
    };

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [setTrending, setConnected]);
}
