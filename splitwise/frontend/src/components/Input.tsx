import type { InputHTMLAttributes } from 'react';
import { cx } from '../utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

/** Labeled text input matching the app field style. */
export function Input({ label, hint, className, id, ...props }: InputProps) {
  const inputId = id || props.name;
  return (
    <div className="space-y-1.5">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-split-ink">
          {label}
        </label>
      )}
      <input id={inputId} className={cx('input-field', className)} {...props} />
      {hint && <p className="text-xs text-split-ink-soft">{hint}</p>}
    </div>
  );
}
