import { AnyRouter, RegisteredRouter, RouterOptions } from '@tanstack/router-core';
import * as React from 'react';
/**
 * Low-level provider that places the router into React context and optionally
 * updates router options from props. Most apps should use `RouterProvider`.
 */
export declare function RouterContextProvider<TRouter extends AnyRouter = RegisteredRouter, TDehydrated extends Record<string, any> = Record<string, any>>({ router, children, ...rest }: RouterProps<TRouter, TDehydrated> & {
    children: React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
/**
 * Top-level component that renders the active route matches and provides the
 * router to the React tree via context.
 *
 * Accepts the same options as `createRouter` via props to update the router
 * instance after creation.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRouterFunction
 */
export declare function RouterProvider<TRouter extends AnyRouter = RegisteredRouter, TDehydrated extends Record<string, any> = Record<string, any>>({ router, ...rest }: RouterProps<TRouter, TDehydrated>): import("react/jsx-runtime").JSX.Element;
export type RouterProps<TRouter extends AnyRouter = RegisteredRouter, TDehydrated extends Record<string, any> = Record<string, any>> = Omit<RouterOptions<TRouter['routeTree'], NonNullable<TRouter['options']['trailingSlash']>, NonNullable<TRouter['options']['defaultStructuralSharing']>, TRouter['history'], TDehydrated>, 'context'> & {
    router: TRouter;
    context?: Partial<RouterOptions<TRouter['routeTree'], NonNullable<TRouter['options']['trailingSlash']>, NonNullable<TRouter['options']['defaultStructuralSharing']>, TRouter['history'], TDehydrated>['context']>;
};
