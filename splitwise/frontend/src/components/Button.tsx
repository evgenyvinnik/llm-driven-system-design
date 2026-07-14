import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../utils';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'outline';
  loading?: boolean;
  children: ReactNode;
}

const VARIANTS = {
  primary: 'bg-split-green text-white hover:bg-split-green-dark shadow-sm',
  ghost: 'text-split-ink-soft hover:bg-split-bg',
  outline: 'border border-split-line text-split-ink hover:bg-split-bg',
  danger: 'bg-split-owe text-white hover:bg-split-owe-dark',
};

/** App button with primary / ghost / outline / danger variants and a loading state. */
export function Button({ variant = 'primary', loading, children, className, disabled, ...props }: ButtonProps) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold rounded-xl px-4 py-2.5',
        'transition active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
      )}
      {children}
    </button>
  );
}
