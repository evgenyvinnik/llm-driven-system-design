/**
 * Component barrel file for clean imports.
 * Re-exports all shared UI components for use throughout the application.
 *
 * @example
 * // Import top-level components
 * import { Header, ContentCard, VideoPlayer } from '../components';
 *
 * @example
 * // Import admin sub-components directly
 * import { AdminTabs, StatCard } from '../components/admin';
 *
 * @example
 * // Import player sub-components directly
 * import { PlayerControls, ProgressBar } from '../components/player';
 */
export { Header } from './Header';
export { ContentCard } from './ContentCard';
export { ContentRow } from './ContentRow';
export { HeroBanner } from './HeroBanner';
export { VideoPlayer } from './VideoPlayer';

// Re-export sub-component directories for convenience
// These can also be imported directly from './admin' or './player'
export * from './admin';
export * from './player';
