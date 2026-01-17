import { AnyRouter, Constrain, LinkOptions, RegisteredRouter, RoutePaths } from '@tanstack/router-core';
import { ReactNode } from 'react';
import { ValidateLinkOptions, ValidateLinkOptionsArray } from './typePrimitives.js';
import * as React from 'react';
/**
 * Build anchor-like props for declarative navigation and preloading.
 *
 * Returns stable `href`, event handlers and accessibility props derived from
 * router options and active state. Used internally by `Link` and custom links.
 *
 * Options cover `to`, `params`, `search`, `hash`, `state`, `preload`,
 * `activeProps`, `inactiveProps`, and more.
 *
 * @returns React anchor props suitable for `<a>` or custom components.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useLinkPropsHook
 */
export declare function useLinkProps<TRouter extends AnyRouter = RegisteredRouter, const TFrom extends string = string, const TTo extends string | undefined = undefined, const TMaskFrom extends string = TFrom, const TMaskTo extends string = ''>(options: UseLinkPropsOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>, forwardedRef?: React.ForwardedRef<Element>): React.ComponentPropsWithRef<'a'>;
type UseLinkReactProps<TComp> = TComp extends keyof React.JSX.IntrinsicElements ? React.JSX.IntrinsicElements[TComp] : TComp extends React.ComponentType<any> ? React.ComponentPropsWithoutRef<TComp> & React.RefAttributes<React.ComponentRef<TComp>> : never;
export type UseLinkPropsOptions<TRouter extends AnyRouter = RegisteredRouter, TFrom extends RoutePaths<TRouter['routeTree']> | string = string, TTo extends string | undefined = '.', TMaskFrom extends RoutePaths<TRouter['routeTree']> | string = TFrom, TMaskTo extends string = '.'> = ActiveLinkOptions<'a', TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & UseLinkReactProps<'a'>;
export type ActiveLinkOptions<TComp = 'a', TRouter extends AnyRouter = RegisteredRouter, TFrom extends string = string, TTo extends string | undefined = '.', TMaskFrom extends string = TFrom, TMaskTo extends string = '.'> = LinkOptions<TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & ActiveLinkOptionProps<TComp>;
type ActiveLinkProps<TComp> = Partial<LinkComponentReactProps<TComp> & {
    [key: `data-${string}`]: unknown;
}>;
export interface ActiveLinkOptionProps<TComp = 'a'> {
    /**
     * A function that returns additional props for the `active` state of this link.
     * These props override other props passed to the link (`style`'s are merged, `className`'s are concatenated)
     */
    activeProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>);
    /**
     * A function that returns additional props for the `inactive` state of this link.
     * These props override other props passed to the link (`style`'s are merged, `className`'s are concatenated)
     */
    inactiveProps?: ActiveLinkProps<TComp> | (() => ActiveLinkProps<TComp>);
}
export type LinkProps<TComp = 'a', TRouter extends AnyRouter = RegisteredRouter, TFrom extends string = string, TTo extends string | undefined = '.', TMaskFrom extends string = TFrom, TMaskTo extends string = '.'> = ActiveLinkOptions<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo> & LinkPropsChildren;
export interface LinkPropsChildren {
    children?: React.ReactNode | ((state: {
        isActive: boolean;
        isTransitioning: boolean;
    }) => React.ReactNode);
}
type LinkComponentReactProps<TComp> = Omit<UseLinkReactProps<TComp>, keyof CreateLinkProps>;
export type LinkComponentProps<TComp = 'a', TRouter extends AnyRouter = RegisteredRouter, TFrom extends string = string, TTo extends string | undefined = '.', TMaskFrom extends string = TFrom, TMaskTo extends string = '.'> = LinkComponentReactProps<TComp> & LinkProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;
export type CreateLinkProps = LinkProps<any, any, string, string, string, string>;
export type LinkComponent<in out TComp, in out TDefaultFrom extends string = string> = <TRouter extends AnyRouter = RegisteredRouter, const TFrom extends string = TDefaultFrom, const TTo extends string | undefined = undefined, const TMaskFrom extends string = TFrom, const TMaskTo extends string = ''>(props: LinkComponentProps<TComp, TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) => React.ReactElement;
export interface LinkComponentRoute<in out TDefaultFrom extends string = string> {
    defaultFrom: TDefaultFrom;
    <TRouter extends AnyRouter = RegisteredRouter, const TTo extends string | undefined = undefined, const TMaskTo extends string = ''>(props: LinkComponentProps<'a', TRouter, this['defaultFrom'], TTo, this['defaultFrom'], TMaskTo>): React.ReactElement;
}
/**
 * Creates a typed Link-like component that preserves TanStack Router's
 * navigation semantics and type-safety while delegating rendering to the
 * provided host component.
 *
 * Useful for integrating design system anchors/buttons while keeping
 * router-aware props (eg. `to`, `params`, `search`, `preload`).
 *
 * @param Comp The host component to render (eg. a design-system Link/Button)
 * @returns A router-aware component with the same API as `Link`.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-link
 */
export declare function createLink<const TComp>(Comp: Constrain<TComp, any, (props: CreateLinkProps) => ReactNode>): LinkComponent<TComp>;
/**
 * A strongly-typed anchor component for declarative navigation.
 * Handles path, search, hash and state updates with optional route preloading
 * and active-state styling.
 *
 * Props:
 * - `preload`: Controls route preloading (eg. 'intent', 'render', 'viewport', true/false)
 * - `preloadDelay`: Delay in ms before preloading on hover
 * - `activeProps`/`inactiveProps`: Additional props merged when link is active/inactive
 * - `resetScroll`/`hashScrollIntoView`: Control scroll behavior on navigation
 * - `viewTransition`/`startTransition`: Use View Transitions/React transitions for navigation
 * - `ignoreBlocker`: Bypass registered blockers
 *
 * @returns An anchor-like element that navigates without full page reloads.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/linkComponent
 */
export declare const Link: LinkComponent<'a'>;
export type LinkOptionsFnOptions<TOptions, TComp, TRouter extends AnyRouter = RegisteredRouter> = TOptions extends ReadonlyArray<any> ? ValidateLinkOptionsArray<TRouter, TOptions, string, TComp> : ValidateLinkOptions<TRouter, TOptions, string, TComp>;
export type LinkOptionsFn<TComp> = <const TOptions, TRouter extends AnyRouter = RegisteredRouter>(options: LinkOptionsFnOptions<TOptions, TComp, TRouter>) => TOptions;
/**
 * Validate and reuse navigation options for `Link`, `navigate` or `redirect`.
 * Accepts a literal options object and returns it typed for later spreading.
 * @example
 * const opts = linkOptions({ to: '/dashboard', search: { tab: 'home' } })
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/linkOptions
 */
export declare const linkOptions: LinkOptionsFn<'a'>;
export {};
/**
 * Type-check a literal object for use with `Link`, `navigate` or `redirect`.
 * Use to validate and reuse navigation options across your app.
 * @example
 * const opts = linkOptions({ to: '/dashboard', search: { tab: 'home' } })
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/linkOptions
 */
