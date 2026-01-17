import { AnyRouter, RegisteredRouter } from '@tanstack/router-core';
/**
 * Access the current TanStack Router instance from React context.
 * Must be used within a `RouterProvider`.
 *
 * Options:
 * - `warn`: Log a warning if no router context is found (default: true).
 *
 * @returns The registered router instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useRouterHook
 */
export declare function useRouter<TRouter extends AnyRouter = RegisteredRouter>(opts?: {
    warn?: boolean;
}): TRouter;
