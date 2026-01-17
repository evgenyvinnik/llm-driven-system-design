import { UseParamsRoute } from './useParams.cjs';
import { UseMatchRoute } from './useMatch.cjs';
import { UseSearchRoute } from './useSearch.cjs';
import { AnyContext, AnyRoute, AnyRouter, Constrain, ConstrainLiteral, FileBaseRouteOptions, FileRoutesByPath, LazyRouteOptions, Register, RegisteredRouter, ResolveParams, Route, RouteById, RouteConstraints, RouteIds, RouteLoaderFn, UpdatableRouteOptions, UseNavigateResult } from '@tanstack/router-core';
import { UseLoaderDepsRoute } from './useLoaderDeps.cjs';
import { UseLoaderDataRoute } from './useLoaderData.cjs';
import { UseRouteContextRoute } from './useRouteContext.cjs';
/**
 * Creates a file-based Route factory for a given path.
 *
 * Used by TanStack Router's file-based routing to associate a file with a
 * route. The returned function accepts standard route options. In normal usage
 * the `path` string is inserted and maintained by the `tsr` generator.
 *
 * @param path File path literal for the route (usually auto-generated).
 * @returns A function that accepts Route options and returns a Route instance.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createFileRouteFunction
 */
export declare function createFileRoute<TFilePath extends keyof FileRoutesByPath, TParentRoute extends AnyRoute = FileRoutesByPath[TFilePath]['parentRoute'], TId extends RouteConstraints['TId'] = FileRoutesByPath[TFilePath]['id'], TPath extends RouteConstraints['TPath'] = FileRoutesByPath[TFilePath]['path'], TFullPath extends RouteConstraints['TFullPath'] = FileRoutesByPath[TFilePath]['fullPath']>(path?: TFilePath): FileRoute<TFilePath, TParentRoute, TId, TPath, TFullPath>['createRoute'];
/**
  @deprecated It's no longer recommended to use the `FileRoute` class directly.
  Instead, use `createFileRoute('/path/to/file')(options)` to create a file route.
*/
export declare class FileRoute<TFilePath extends keyof FileRoutesByPath, TParentRoute extends AnyRoute = FileRoutesByPath[TFilePath]['parentRoute'], TId extends RouteConstraints['TId'] = FileRoutesByPath[TFilePath]['id'], TPath extends RouteConstraints['TPath'] = FileRoutesByPath[TFilePath]['path'], TFullPath extends RouteConstraints['TFullPath'] = FileRoutesByPath[TFilePath]['fullPath']> {
    path?: TFilePath | undefined;
    silent?: boolean;
    constructor(path?: TFilePath | undefined, _opts?: {
        silent: boolean;
    });
    createRoute: <TRegister = Register, TSearchValidator = undefined, TParams = ResolveParams<TPath>, TRouteContextFn = AnyContext, TBeforeLoadFn = AnyContext, TLoaderDeps extends Record<string, any> = {}, TLoaderFn = undefined, TChildren = unknown, TSSR = unknown, const TMiddlewares = unknown, THandlers = undefined>(options?: FileBaseRouteOptions<TRegister, TParentRoute, TId, TPath, TSearchValidator, TParams, TLoaderDeps, TLoaderFn, AnyContext, TRouteContextFn, TBeforeLoadFn, AnyContext, TSSR, TMiddlewares, THandlers> & UpdatableRouteOptions<TParentRoute, TId, TFullPath, TParams, TSearchValidator, TLoaderFn, TLoaderDeps, AnyContext, TRouteContextFn, TBeforeLoadFn>) => Route<TRegister, TParentRoute, TPath, TFullPath, TFilePath, TId, TSearchValidator, TParams, AnyContext, TRouteContextFn, TBeforeLoadFn, TLoaderDeps, TLoaderFn, TChildren, unknown, TSSR, TMiddlewares, THandlers>;
}
/**
  @deprecated It's recommended not to split loaders into separate files.
  Instead, place the loader function in the main route file via `createFileRoute`.
*/
export declare function FileRouteLoader<TFilePath extends keyof FileRoutesByPath, TRoute extends FileRoutesByPath[TFilePath]['preLoaderRoute']>(_path: TFilePath): <TLoaderFn>(loaderFn: Constrain<TLoaderFn, RouteLoaderFn<Register, TRoute['parentRoute'], TRoute['types']['id'], TRoute['types']['params'], TRoute['types']['loaderDeps'], TRoute['types']['routerContext'], TRoute['types']['routeContextFn'], TRoute['types']['beforeLoadFn']>>) => TLoaderFn;
declare module '@tanstack/router-core' {
    interface LazyRoute<in out TRoute extends AnyRoute> {
        useMatch: UseMatchRoute<TRoute['id']>;
        useRouteContext: UseRouteContextRoute<TRoute['id']>;
        useSearch: UseSearchRoute<TRoute['id']>;
        useParams: UseParamsRoute<TRoute['id']>;
        useLoaderDeps: UseLoaderDepsRoute<TRoute['id']>;
        useLoaderData: UseLoaderDataRoute<TRoute['id']>;
        useNavigate: () => UseNavigateResult<TRoute['fullPath']>;
    }
}
export declare class LazyRoute<TRoute extends AnyRoute> {
    options: {
        id: string;
    } & LazyRouteOptions;
    constructor(opts: {
        id: string;
    } & LazyRouteOptions);
    useMatch: UseMatchRoute<TRoute['id']>;
    useRouteContext: UseRouteContextRoute<TRoute['id']>;
    useSearch: UseSearchRoute<TRoute['id']>;
    useParams: UseParamsRoute<TRoute['id']>;
    useLoaderDeps: UseLoaderDepsRoute<TRoute['id']>;
    useLoaderData: UseLoaderDataRoute<TRoute['id']>;
    useNavigate: () => UseNavigateResult<TRoute["fullPath"]>;
}
/**
 * Creates a lazily-configurable code-based route stub by ID.
 *
 * Use this for code-splitting with code-based routes. The returned function
 * accepts only non-critical route options like `component`, `pendingComponent`,
 * `errorComponent`, and `notFoundComponent` which are applied when the route
 * is matched.
 *
 * @param id Route ID string literal to associate with the lazy route.
 * @returns A function that accepts lazy route options and returns a `LazyRoute`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createLazyRouteFunction
 */
export declare function createLazyRoute<TRouter extends AnyRouter = RegisteredRouter, TId extends string = string, TRoute extends AnyRoute = RouteById<TRouter['routeTree'], TId>>(id: ConstrainLiteral<TId, RouteIds<TRouter['routeTree']>>): (opts: LazyRouteOptions) => LazyRoute<TRoute>;
/**
 * Creates a lazily-configurable file-based route stub by file path.
 *
 * Use this for code-splitting with file-based routes (eg. `.lazy.tsx` files).
 * The returned function accepts only non-critical route options like
 * `component`, `pendingComponent`, `errorComponent`, and `notFoundComponent`.
 *
 * @param id File path literal for the route file.
 * @returns A function that accepts lazy route options and returns a `LazyRoute`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/createLazyFileRouteFunction
 */
export declare function createLazyFileRoute<TFilePath extends keyof FileRoutesByPath, TRoute extends FileRoutesByPath[TFilePath]['preLoaderRoute']>(id: TFilePath): (opts: LazyRouteOptions) => LazyRoute<TRoute>;
