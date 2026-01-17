import { classNames } from '../utils';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, className = '', ...props }: InputProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <input
        {...props}
        className={classNames(
          'w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue focus:border-transparent',
          error ? 'border-red-500' : 'border-gray-300',
          className
        )}
      />
      {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
    </div>
  );
}

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function TextArea({ label, error, className = '', ...props }: TextAreaProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-700 mb-1">
          {label}
        </label>
      )}
      <textarea
        {...props}
        className={classNames(
          'w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-venmo-blue focus:border-transparent resize-none',
          error ? 'border-red-500' : 'border-gray-300',
          className
        )}
      />
      {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
    </div>
  );
}
