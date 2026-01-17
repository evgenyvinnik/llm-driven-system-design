/**
 * TabButton - A navigation tab button component.
 * Used in tabbed interfaces to switch between different content panels.
 *
 * @param active - Whether this tab is currently selected
 * @param onClick - Handler called when the tab is clicked
 * @param children - The tab label content
 */
interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

export function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`py-4 px-1 border-b-2 font-medium text-sm ${
        active
          ? 'border-blue-500 text-blue-600'
          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  );
}
