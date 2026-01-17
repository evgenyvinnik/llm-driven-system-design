import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SearchModal } from '../components';

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <SearchModal />
    </>
  ),
});
