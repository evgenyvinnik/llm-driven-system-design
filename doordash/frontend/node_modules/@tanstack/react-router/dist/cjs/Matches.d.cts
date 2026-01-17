import { StructuralSharingOption, ValidateSelected } from './structuralSharing.cjs';
import { AnyRouter, DeepPartial, Expand, MakeOptionalPathParams, MakeOptionalSearchParams, MakeRouteMatchUnion, MaskOptions, MatchRouteOptions, NoInfer, RegisteredRouter, ResolveRelativePath, ResolveRoute, RouteByPath, ToSubOptionsProps } from '@tanstack/router-core';
import * as React from 'react';
declare module '@tanstack/router-core' {
    interface RouteMatchExtensions {
        meta?: Array<React.JSX.IntrinsicElements['meta'] | undefined>;
        links?: Array<React.JSX.IntrinsicElements['link'] | undefined>;
        scripts?: Array<React.JSX.IntrinsicElements['script'] | undefined>;
        styles?: Array<React.JSX.IntrinsicElements['style'] | undefined>;
        headScripts?: Array<React.JSX.IntrinsicElements['script'] | undefined>;
    }
}
/**
 * Internal component that renders the router's active match tree with
 * suspense, error, and not-found boundaries. Rendered by `RouterProvider`.
 */
export declare function Matches(): import("react/jsx-runtime").JSX.Element;
export type UseMatchRouteOptions<TRouter extends AnyRouter = RegisteredRouter, TFrom extends string = string, TTo extends string | undefined = undefined, TMaskFrom extends string = TFrom, TMaskTo extends string = ''> = ToSubOptionsProps<TRouter, TFrom, TTo> & DeepPartial<MakeOptionalSearchParams<TRouter, TFrom, TTo>> & DeepPartial<MakeOptionalPathParams<TRouter, TFrom, TTo>> & MaskOptions<TRouter, TMaskFrom, TMaskTo> & MatchRouteOptions;
/**
 * Create a matcher function for testing locations against route definitions.
 *
 * The returned function accepts standard navigation options (`to`, `params`,
 * `search`, etc.) and returns either `false` (no match) or the matched params
 * object when the route matches the current or pending location.
 *
 * Useful for conditional rendering and active UI states.
 *
 * @returns A `matchRoute(options)` function that returns `false` or params.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchRouteHook
 */
export declare function useMatchRoute<TRouter extends AnyRouter = RegisteredRouter>(): <const TFrom extends string = string, const TTo extends string | undefined = undefined, const TMaskFrom extends string = TFrom, const TMaskTo extends string = "">(opts: UseMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) => false | Expand<ResolveRoute<TRouter, TFrom, TTo>["types"]["allParams"]>;
export type MakeMatchRouteOptions<TRouter extends AnyRouter = RegisteredRouter, TFrom extends string = string, TTo extends string | undefined = undefined, TMaskFrom extends string = TFrom, TMaskTo extends string = ''> = UseMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & {
    children?: ((params?: RouteByPath<TRouter['routeTree'], ResolveRelativePath<TFrom, NoInfer<TTo>>>['types']['allParams']) => React.ReactNode) | React.ReactNode;
};
/**
 * Component that conditionally renders its children based on whether a route
 * matches the provided `from`/`to` options. If `children` is a function, it
 * receives the matched params object.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/matchRouteComponent
 */
export declare function MatchRoute<TRouter extends AnyRouter = RegisteredRouter, const TFrom extends string = string, const TTo extends string | undefined = undefined, const TMaskFrom extends string = TFrom, const TMaskTo extends string = ''>(props: MakeMatchRouteOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>): any;
export interface UseMatchesBaseOptions<TRouter extends AnyRouter, TSelected, TStructuralSharing> {
    select?: (matches: Array<MakeRouteMatchUnion<TRouter>>) => ValidateSelected<TRouter, TSelected, TStructuralSharing>;
}
export type UseMatchesResult<TRouter extends AnyRouter, TSelected> = unknown extends TSelected ? Array<MakeRouteMatchUnion<TRouter>> : TSelected;
export declare function useMatches<TRouter extends AnyRouter = RegisteredRouter, TSelected = unknown, TStructuralSharing extends boolean = boolean>(opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> & StructuralSharingOption<TRouter, TSelected, TStructuralSharing>): UseMatchesResult<TRouter, TSelected>;
/**
 * Read the full array of active route matches or select a derived subset.
 *
 * Useful for debugging, breadcrumbs, or aggregating metadata across matches.
 *
 * @returns The array of matches (or the selected value).
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchesHook
 */
/**
 * Read the full array of active route matches or select a derived subset.
 *
 * Useful for debugging, breadcrumbs, or aggregating metadata across matches.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useMatchesHook
 */
export declare function useParentMatches<TRouter extends AnyRouter = RegisteredRouter, TSelected = unknown, TStructuralSharing extends boolean = boolean>(opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> & StructuralSharingOption<TRouter, TSelected, TStructuralSharing>): UseMatchesResult<TRouter, TSelected>;
/**
 * Read the array of active route matches that are children of the current
 * match (or selected parent) in the match tree.
 */
export declare function useChildMatches<TRouter extends AnyRouter = RegisteredRouter, TSelected = unknown, TStructuralSharing extends boolean = boolean>(opts?: UseMatchesBaseOptions<TRouter, TSelected, TStructuralSharing> & StructuralSharingOption<TRouter, TSelected, TStructuralSharing>): UseMatchesResult<TRouter, TSelected>;
