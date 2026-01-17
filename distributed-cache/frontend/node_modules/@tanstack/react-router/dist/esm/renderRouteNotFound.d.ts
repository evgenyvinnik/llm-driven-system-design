import { AnyRoute, AnyRouter } from '@tanstack/router-core';
/**
 * Renders a not found component for a route when no matching route is found.
 *
 * @param router - The router instance containing the route configuration
 * @param route - The route that triggered the not found state
 * @param data - Additional data to pass to the not found component
 * @returns The rendered not found component or a default fallback component
 */
export declare function renderRouteNotFound(router: AnyRouter, route: AnyRoute, data: any): import("react/jsx-runtime").JSX.Element;
