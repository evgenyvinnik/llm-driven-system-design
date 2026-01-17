import { BaseRootRoute, BaseRoute, BaseRouteApi, AnyContext, AnyRoute, AnyRouter, ConstrainLiteral, ErrorComponentProps, NotFoundError, NotFoundRouteProps, Register, RegisteredRouter, ResolveFullPath, ResolveId, ResolveParams, RootRoute as RootRouteCore, RootRouteId, RootRouteOptions, RouteConstraints, Route as RouteCore, RouteIds, RouteMask, RouteOptions, RouteTypesById, RouterCore, ToMaskOptions, UseNavigateResult } from '@tanstack/router-core';
import { default as React } from 'react';
import { UseLoaderDataRoute } from './useLoaderData.js';
import { UseMatchRoute } from './useMatch.js';
import { UseLoaderDepsRoute } from './useLoaderDeps.js';
import { UseParamsRoute } from './useParams.js';
import { UseSearchRoute } from './useSearch.js';
import { UseRouteContextRoute } from './useRouteContext.js';
import { LinkComponentRoute } from './link.js';
declare module '@tanstack/router-core' {
    interface UpdatableRouteOptionsExtensions {
        component?: RouteComponent;
        errorComponent?: false | null | undefined | ErrorRouteComponent;
        notFoundComponent?: NotFoundRouteComponent;
        pendingComponent?: RouteComponent;
    }
    interface RootRouteOptionsExtensions {
        shellComponent?: ({ children, }: {
            children: React.ReactNode;
        }) => React.ReactNode;
    }
    interface RouteExtensions<in out TId extends string, in out TFullPath extends string> {
        useMatch: UseMatchRoute<TId>;
        useRouteContext: UseRouteContextRoute<TId>;
        useSearch: UseSearchRoute<TId>;
        useParams: UseParamsRoute<TId>;
        useLoaderDeps: UseLoaderDepsRoute<TId>;
        useLoaderData: UseLoaderDataRoute<TId>;
        useNavigate: () => UseNavigateResult<TFullPath>;
        Link: LinkComponentRoute<TFullPath>;
    }
}
/**
 * Returns a route-specific API that exposes type-safe hooks pre-bound
 * to a single route ID. Useful for consuming a route's APIs from files
 * where the route object isn't directly imported (e.g. code-split files).
 *
 * @param id Route ID string literal for the target route.
 * @returns A `RouteApi` instance bound to the given route ID.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/getRouteApiFunction
 */
export declare function getRouteApi<const TId, TRouter extends AnyRouter = RegisteredRouter>(id: ConstrainLiteral<TId, RouteIds<TRouter['routeTree']>>): RouteApi<TId, TRouter>;
export declare class RouteApi<TId, TRouter extends AnyRouter = RegisteredRouter> extends BaseRouteApi<TId, TRouter> {
    /**
     * @deprecated Use the `getRouteApi` function instead.
     */
    constructor({ id }: {
        id: TId;
    });
    useMatch: UseMatchRoute<TId>;
    useRouteContext: UseRouteContextRoute<TId>;
    useSearch: UseSearchRoute<TId>;
    useParams: UseParamsRoute<TId>;
    useLoaderDeps: UseLoaderDepsRoute<TId>;
    useLoaderData: UseLoaderDataRoute<TId>;
    useNavigate: () => UseNavigateResult<RouteTypesById<TRouter, TId>["fullPath"]>;
    notFound: (opts?: NotFoundError) => NotFoundError;
    Link: LinkComponentRoute<RouteTypesById<TRouter, TId>['fullPath']>;
}
export declare class Route<in out TRegister = unknown, in out TParentRoute extends RouteConstraints['TParentRoute'] = AnyRoute, in out TPath extends RouteConstraints['TPath'] = '/', in out TFullPath extends RouteConstraints['TFullPath'] = ResolveFullPath<TParentRoute, TPath>, in out TCustomId extends RouteConstraints['TCustomId'] = string, in out TId extends RouteConstraints['TId'] = ResolveId<TParentRoute, TCustomId, TPath>, in out TSearchValidator = undefined, in out TParams = ResolveParams<TPath>, in out TRouterContext = AnyContext, in out TRouteContextFn = AnyContext, in out TBeforeLoadFn = AnyContext, in out TLoaderDeps extends Record<string, any> = {}, in out TLoaderFn = undefined, in out TChildren = unknown, in out TFileRouteTypes = unknown, in out TSSR = unknown, in out TServerMiddlewares = unknown, in out THandlers = undefined> extends BaseRoute<TRegister, TParentRoute, TPath, TFullPath, TCustomId, TId, TSearchValidator, TParams, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TFileRouteTypes, TSSR, TServerMiddlewares, THandlers> implements RouteCore<TRegister, TParentRoute, TPath, TFullPath, TCustomId, TId, TSearchValidator, TParams, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TFileRouteTypes, TSSR, TServerMiddlewares, THandlers> {
    /**
     * @deprecated Use the `createRoute` function instead.
     */
    constructor(options?: RouteOptions<TRegister, TParentRoute, TId, TCustomId, TFullPath, TPath, TSearchValidator, TParams, TLoaderDeps, TLoaderFn, TRouterContext, TRouteContextFn, TBeforeLoadFn, TSSR, TServerMiddlewares, THandlers>);
    useMatch: UseMatchRoute<TId>;
    useRouteContext: UseRouteContextRoute<TId>;
    useSearch: UseSearchRoute<TId>;
    useParams: UseParamsRoute<TId>;
    useLoaderDeps: UseLoaderDepsRoute<TId>;
    useLoaderData: UseLoaderDataRoute<TId>;
    useNavigate: () => UseNavigateResult<TFullPath>;
    Link: LinkComponentRoute<TFullPath>;
}
/**
 * Creates a non-root Route instance for code-based routing.
 *
 * Use this to define a route that will be composed into a route tree
 * (typically via a parent route's `addChildren`). If you're using file-based
 * routing, prefer `createFileRoute`.
 *
 * @param options Route options (path, component, loader, context, etc.).
 * @returns A Route instance to be attached to the route tree.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRouteFunction
 */
export declare function createRoute<TRegister = unknown, TParentRoute extends RouteConstraints['TParentRoute'] = AnyRoute, TPath extends RouteConstraints['TPath'] = '/', TFullPath extends RouteConstraints['TFullPath'] = ResolveFullPath<TParentRoute, TPath>, TCustomId extends RouteConstraints['TCustomId'] = string, TId extends RouteConstraints['TId'] = ResolveId<TParentRoute, TCustomId, TPath>, TSearchValidator = undefined, TParams = ResolveParams<TPath>, TRouteContextFn = AnyContext, TBeforeLoadFn = AnyContext, TLoaderDeps extends Record<string, any> = {}, TLoaderFn = undefined, TChildren = unknown, TSSR = unknown, const TServerMiddlewares = unknown>(options: RouteOptions<TRegister, TParentRoute, TId, TCustomId, TFullPath, TPath, TSearchValidator, TParams, TLoaderDeps, TLoaderFn, AnyContext, TRouteContextFn, TBeforeLoadFn, TSSR, TServerMiddlewares>): Route<TRegister, TParentRoute, TPath, TFullPath, TCustomId, TId, TSearchValidator, TParams, AnyContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TSSR, TServerMiddlewares>;
export type AnyRootRoute = RootRoute<any, any, any, any, any, any, any, any, any, any, any>;
/**
 * Creates a root route factory that requires a router context type.
 *
 * Use when your root route expects `context` to be provided to `createRouter`.
 * The returned function behaves like `createRootRoute` but enforces a context type.
 *
 * @returns A factory function to configure and return a root route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteWithContextFunction
 */
export declare function createRootRouteWithContext<TRouterContext extends {}>(): <TRegister = Register, TRouteContextFn = AnyContext, TBeforeLoadFn = AnyContext, TSearchValidator = undefined, TLoaderDeps extends Record<string, any> = {}, TLoaderFn = undefined, TSSR = unknown, TServerMiddlewares = unknown>(options?: RootRouteOptions<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TSSR, TServerMiddlewares>) => RootRoute<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, unknown, unknown, TSSR, TServerMiddlewares, undefined>;
/**
 * @deprecated Use the `createRootRouteWithContext` function instead.
 */
export declare const rootRouteWithContext: typeof createRootRouteWithContext;
export declare class RootRoute<in out TRegister = unknown, in out TSearchValidator = undefined, in out TRouterContext = {}, in out TRouteContextFn = AnyContext, in out TBeforeLoadFn = AnyContext, in out TLoaderDeps extends Record<string, any> = {}, in out TLoaderFn = undefined, in out TChildren = unknown, in out TFileRouteTypes = unknown, in out TSSR = unknown, in out TServerMiddlewares = unknown, in out THandlers = undefined> extends BaseRootRoute<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TFileRouteTypes, TSSR, TServerMiddlewares, THandlers> implements RootRouteCore<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TFileRouteTypes, TSSR, TServerMiddlewares, THandlers> {
    /**
     * @deprecated `RootRoute` is now an internal implementation detail. Use `createRootRoute()` instead.
     */
    constructor(options?: RootRouteOptions<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TSSR, TServerMiddlewares, THandlers>);
    useMatch: UseMatchRoute<RootRouteId>;
    useRouteContext: UseRouteContextRoute<RootRouteId>;
    useSearch: UseSearchRoute<RootRouteId>;
    useParams: UseParamsRoute<RootRouteId>;
    useLoaderDeps: UseLoaderDepsRoute<RootRouteId>;
    useLoaderData: UseLoaderDataRoute<RootRouteId>;
    useNavigate: () => UseNavigateResult<"/">;
    Link: LinkComponentRoute<'/'>;
}
/**
 * Creates a root Route instance used to build your route tree.
 *
 * Typically paired with `createRouter({ routeTree })`. If you need to require
 * a typed router context, use `createRootRouteWithContext` instead.
 *
 * @param options Root route options (component, error, pending, etc.).
 * @returns A root route instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteFunction
 */
export declare function createRootRoute<TRegister = Register, TSearchValidator = undefined, TRouterContext = {}, TRouteContextFn = AnyContext, TBeforeLoadFn = AnyContext, TLoaderDeps extends Record<string, any> = {}, TLoaderFn = undefined, TSSR = unknown, const TServerMiddlewares = unknown, THandlers = undefined>(options?: RootRouteOptions<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TSSR, TServerMiddlewares, THandlers>): RootRoute<TRegister, TSearchValidator, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, unknown, unknown, TSSR, TServerMiddlewares, THandlers>;
export declare function createRouteMask<TRouteTree extends AnyRoute, TFrom extends string, TTo extends string>(opts: {
    routeTree: TRouteTree;
} & ToMaskOptions<RouterCore<TRouteTree, 'never', boolean>, TFrom, TTo>): RouteMask<TRouteTree>;
export interface DefaultRouteTypes<TProps> {
    component: ((props: TProps) => any) | React.LazyExoticComponent<(props: TProps) => any>;
}
export interface RouteTypes<TProps> extends DefaultRouteTypes<TProps> {
}
export type AsyncRouteComponent<TProps> = RouteTypes<TProps>['component'] & {
    preload?: () => Promise<void>;
};
export type RouteComponent = AsyncRouteComponent<{}>;
export type ErrorRouteComponent = AsyncRouteComponent<ErrorComponentProps>;
export type NotFoundRouteComponent = RouteTypes<NotFoundRouteProps>['component'];
export declare class NotFoundRoute<TRegister, TParentRoute extends AnyRootRoute, TRouterContext = AnyContext, TRouteContextFn = AnyContext, TBeforeLoadFn = AnyContext, TSearchValidator = undefined, TLoaderDeps extends Record<string, any> = {}, TLoaderFn = undefined, TChildren = unknown, TSSR = unknown, TServerMiddlewares = unknown> extends Route<TRegister, TParentRoute, '/404', '/404', '404', '404', TSearchValidator, {}, TRouterContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, TSSR, TServerMiddlewares> {
    constructor(options: Omit<RouteOptions<TRegister, TParentRoute, string, string, string, string, TSearchValidator, {}, TLoaderDeps, TLoaderFn, TRouterContext, TRouteContextFn, TBeforeLoadFn, TSSR, TServerMiddlewares>, 'caseSensitive' | 'parseParams' | 'stringifyParams' | 'path' | 'id' | 'params'>);
}
