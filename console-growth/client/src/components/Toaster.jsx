import { useEffect, useState } from 'react';
import { onToast } from '../lib/toast.js';

const TOAST_MS = 4_000;

export default function Toaster() {
  const [items, setItems] = useState([]);

  useEffect(
    () =>
      onToast((item) => {
        setItems((current) => [...current, item]);
        setTimeout(() => setItems((current) => current.filter((existing) => existing.id !== item.id)), TOAST_MS);
      }),
    [],
  );

  return (
    <div className="toaster" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className="toast">
          {item.message}
        </div>
      ))}
    </div>
  );
}
