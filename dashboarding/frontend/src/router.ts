import { createRouter } from '@tanstack/react-router';
import { Route as RootRoute } from './routes/__root';
import { Route as IndexRoute } from './routes/index';
import { Route as DashboardRoute } from './routes/dashboard.$dashboardId';
import { Route as AlertsRoute } from './routes/alerts';
import { Route as MetricsRoute } from './routes/metrics';

const routeTree = RootRoute.addChildren([
  IndexRoute,
  DashboardRoute,
  AlertsRoute,
  MetricsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
