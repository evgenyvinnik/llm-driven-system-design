/**
 * Admin components barrel file for clean imports.
 * Re-exports all admin dashboard sub-components.
 *
 * @example
 * import { AdminTabs, StatCard, OverviewTab } from '../components/admin';
 */
export { AdminTabs } from './AdminTabs';
export type { AdminTabType } from './AdminTabs';
export { StatCard } from './StatCard';
export type { StatCardColor } from './StatCard';
export { OverviewTab } from './OverviewTab';
export { ContentTab } from './ContentTab';
export { UsersTab } from './UsersTab';
export type { AdminStats, AdminContent, AdminUser } from './types';
