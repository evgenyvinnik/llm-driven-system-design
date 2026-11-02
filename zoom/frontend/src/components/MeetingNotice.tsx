import { useEffect } from 'react';
import { useMeetingStore } from '../stores/meetingStore';

/** Shows the latest server notice (muted by host, role changes, refused actions) for a few seconds. */
export function MeetingNotice() {
  const { notice, setNotice } = useMeetingStore();

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  if (!notice) return null;

  return (
    <div
      role="status"
      className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-zoom-card border border-zoom-primary text-zoom-text text-sm px-4 py-2 rounded-lg shadow-lg"
    >
      {notice}
    </div>
  );
}
