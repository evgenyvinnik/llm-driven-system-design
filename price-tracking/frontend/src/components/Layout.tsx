/**
 * Page layout wrapper component.
 * Provides consistent header and main content container.
 * @module components/Layout
 */
import { ReactNode } from 'react';
import { Header } from './Header';

/** Props for the Layout component */
interface LayoutProps {
  /** Child content to render in the main area */
  children: ReactNode;
}

/**
 * Wraps page content with the standard layout.
 * Includes Header and a centered main content area.
 * @param props - Component props
 * @param props.children - Page content to render
 */
export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
