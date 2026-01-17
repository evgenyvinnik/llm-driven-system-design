/**
 * Tanstack Router configuration.
 * Creates the router instance from the auto-generated route tree.
 */

import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/** Application router instance */
export const router = createRouter({ routeTree });

/** Type declaration for router registration */
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
