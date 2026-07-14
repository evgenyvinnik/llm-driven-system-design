import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { CloseIcon } from './icons';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
}

/** Centered modal dialog with a header, scrollable body, and optional sticky footer. */
export function Modal({ open, onClose, title, children, footer, maxWidth = 'max-w-lg' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-split-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className={`relative w-full ${maxWidth} bg-white sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col animate-[slideup_0.2s_ease-out]`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-split-line">
          <h2 className="text-lg font-bold text-split-ink">{title}</h2>
          <button onClick={onClose} className="text-split-ink-soft hover:text-split-ink p-1 rounded-lg hover:bg-split-bg">
            <CloseIcon className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-split-line bg-split-bg/40 sm:rounded-b-2xl">{footer}</div>}
      </div>
    </div>
  );
}
