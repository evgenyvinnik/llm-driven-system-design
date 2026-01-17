import { clsx } from 'clsx';
import type { IssueType, Priority, StatusCategory } from '../types';

// Issue type icons
export function IssueTypeIcon({ type, className = '' }: { type: IssueType; className?: string }) {
  const baseClass = clsx('w-4 h-4', className);

  switch (type) {
    case 'bug':
      return (
        <svg className={clsx(baseClass, 'text-red-500')} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="10" />
        </svg>
      );
    case 'story':
      return (
        <svg className={clsx(baseClass, 'text-green-500')} viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      );
    case 'task':
      return (
        <svg className={clsx(baseClass, 'text-blue-500')} viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      );
    case 'epic':
      return (
        <svg className={clsx(baseClass, 'text-purple-500')} viewBox="0 0 24 24" fill="currentColor">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      );
    case 'subtask':
      return (
        <svg className={clsx(baseClass, 'text-gray-500')} viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="6" width="12" height="12" rx="1" />
        </svg>
      );
  }
}

// Priority icons
export function PriorityIcon({ priority, className = '' }: { priority: Priority; className?: string }) {
  const baseClass = clsx('w-4 h-4', className);

  const colors: Record<Priority, string> = {
    highest: 'text-red-600',
    high: 'text-orange-500',
    medium: 'text-yellow-500',
    low: 'text-green-500',
    lowest: 'text-teal-500',
  };

  const arrows: Record<Priority, 'up' | 'down' | 'equal'> = {
    highest: 'up',
    high: 'up',
    medium: 'equal',
    low: 'down',
    lowest: 'down',
  };

  const arrow = arrows[priority];

  if (arrow === 'up') {
    return (
      <svg className={clsx(baseClass, colors[priority])} viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 14l5-5 5 5H7z" />
      </svg>
    );
  } else if (arrow === 'down') {
    return (
      <svg className={clsx(baseClass, colors[priority])} viewBox="0 0 24 24" fill="currentColor">
        <path d="M7 10l5 5 5-5H7z" />
      </svg>
    );
  } else {
    return (
      <svg className={clsx(baseClass, colors[priority])} viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="11" width="16" height="2" />
      </svg>
    );
  }
}

// Status badge
export function StatusBadge({ name, category }: { name: string; category: StatusCategory }) {
  const categoryColors: Record<StatusCategory, string> = {
    todo: 'bg-gray-200 text-gray-700',
    in_progress: 'bg-blue-500 text-white',
    done: 'bg-green-500 text-white',
  };

  return (
    <span className={clsx('px-2 py-0.5 rounded text-xs font-medium', categoryColors[category])}>
      {name}
    </span>
  );
}

// User avatar
export function Avatar({
  user,
  size = 'md',
}: {
  user?: { name: string; avatar_url?: string };
  size?: 'sm' | 'md' | 'lg';
}) {
  const sizes = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  if (!user) {
    return (
      <div className={clsx(sizes[size], 'rounded-full bg-gray-300 flex items-center justify-center text-gray-500')}>
        ?
      </div>
    );
  }

  if (user.avatar_url) {
    return <img src={user.avatar_url} alt={user.name} className={clsx(sizes[size], 'rounded-full object-cover')} />;
  }

  const initials = user.name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className={clsx(sizes[size], 'rounded-full bg-blue-500 text-white flex items-center justify-center font-medium')}>
      {initials}
    </div>
  );
}

// Button component
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  disabled = false,
  type = 'button',
  onClick,
  className = '',
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  className?: string;
}) {
  const variants = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300',
    secondary: 'bg-gray-200 text-gray-800 hover:bg-gray-300 disabled:bg-gray-100',
    ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 disabled:text-gray-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300',
  };

  const sizes = {
    sm: 'px-2 py-1 text-sm',
    md: 'px-4 py-2',
    lg: 'px-6 py-3 text-lg',
  };

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'rounded font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
        variants[variant],
        sizes[size],
        className
      )}
    >
      {children}
    </button>
  );
}

// Input component
export function Input({
  type = 'text',
  placeholder,
  value,
  onChange,
  disabled = false,
  className = '',
  ...props
}: {
  type?: 'text' | 'email' | 'password' | 'number';
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  className?: string;
  name?: string;
  id?: string;
}) {
  return (
    <input
      type={type}
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={clsx(
        'w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent',
        'disabled:bg-gray-100 disabled:text-gray-500',
        className
      )}
      {...props}
    />
  );
}

// Textarea component
export function Textarea({
  placeholder,
  value,
  onChange,
  rows = 4,
  disabled = false,
  className = '',
}: {
  placeholder?: string;
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <textarea
      placeholder={placeholder}
      value={value}
      onChange={onChange}
      rows={rows}
      disabled={disabled}
      className={clsx(
        'w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none',
        'disabled:bg-gray-100 disabled:text-gray-500',
        className
      )}
    />
  );
}

// Select component
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
  className = '',
}: {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={clsx(
        'w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white',
        'disabled:bg-gray-100 disabled:text-gray-500',
        className
      )}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// Loading spinner
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  return (
    <div className={clsx(sizes[size], 'animate-spin rounded-full border-2 border-gray-300 border-t-blue-600')} />
  );
}

// Empty state
export function EmptyState({ message, action }: { message: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
      <svg className="w-16 h-16 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1}
          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
        />
      </svg>
      <p className="text-lg mb-4">{message}</p>
      {action && (
        <Button variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

// Modal component
export function Modal({
  isOpen,
  onClose,
  title,
  children,
  size = 'md',
}: {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="fixed inset-0 bg-black bg-opacity-50 transition-opacity" onClick={onClose} />
        <div className={clsx('relative bg-white rounded-lg shadow-xl w-full', sizes[size])}>
          {title && (
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">{title}</h2>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className="p-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
