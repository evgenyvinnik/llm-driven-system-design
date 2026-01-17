import { Store } from '@tanstack/store';
import { loadRouteChunk } from './load-matches.cjs';
import { ProcessedTree } from './new-process-route-tree.cjs';
import { SearchParser, SearchSerializer } from './searchParams.cjs';
import { AnyRedirect, ResolvedRedirect } from './redirect.cjs';
import { HistoryLocation, HistoryState, ParsedHistoryState, RouterHistory } from '@tanstack/history';
import { Awaitable, Constrain, ControlledPromise, NoInfer, NonNullableUpdater, PickAsRequired, Updater } from './utils.cjs';
import { ParsedLocation } from './location.cjs';
import { AnyContext, AnyRoute, AnyRouteWithContext, MakeRemountDepsOptionsUnion, RouteLike, RouteMask } from './route.cjs';
import { FullSearchSchema, RouteById, RoutePaths, RoutesById, RoutesByPath } from './routeInfo.cjs';
import { AnyRouteMatch, MakeRouteMatchUnion, MatchRouteOptions } from './Matches.cjs';
import { BuildLocationFn, CommitLocationOptions, NavigateFn } from './RouterProvider.cjs';
import { Manifest, RouterManagedTag } from './manifest.cjs';
import { AnySchema } from './validators.cjs';
import { NavigateOptions, ResolveRelativePath, ToOptions } from './link.cjs';
import { AnySerializationAdapter, ValidateSerializableInput } from './ssr/serializer/transformer.cjs';
export type ControllablePromise<T = any> = Promise<T> & {
    resolve: (value: T) => void;
    reject: (value?: any) => void;
};
export type InjectedHtmlEntry = Promise<string>;
export interface Register {
}
export type RegisteredSsr<TRegister = Register> = TRegister extends {
    ssr: infer TSSR;
} ? TSSR : false;
export type RegisteredRouter<TRegister = Register> = TRegister extends {
    router: infer TRouter;
} ? TRouter : AnyRouter;
export type RegisteredConfigType<TRegister, TKey> = TRegister extends {
    config: infer TConfig;
} ? TConfig extends {
    '~types': infer TTypes;
} ? TKey extends keyof TTypes ? TTypes[TKey] : unknown : unknown : unknown;
export type DefaultRemountDepsFn<TRouteTree extends AnyRoute> = (opts: MakeRemountDepsOptionsUnion<TRouteTree>) => any;
export interface DefaultRouterOptionsExtensions {
}
export interface RouterOptionsExtensions extends DefaultRouterOptionsExtensions {
}
export type SSROption = boolean | 'data-only';
export interface RouterOptions<TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption, TDefaultStructuralSharingOption extends boolean = false, TRouterHistory extends RouterHistory = RouterHistory, TDehydrated = undefined> extends RouterOptionsExtensions {
    /**
     * The history object that will be used to manage the browser history.
     *
     * If not provided, a new createBrowserHistory instance will be created and used.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#history-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/history-types)
     */
    history?: TRouterHistory;
    /**
     * A function that will be used to stringify search params when generating links.
     *
     * @default defaultStringifySearch
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#stringifysearch-method)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization)
     */
    stringifySearch?: SearchSerializer;
    /**
     * A function that will be used to parse search params when parsing the current location.
     *
     * @default defaultParseSearch
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#parsesearch-method)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization)
     */
    parseSearch?: SearchParser;
    /**
     * If `false`, routes will not be preloaded by default in any way.
     *
     * If `'intent'`, routes will be preloaded by default when the user hovers over a link or a `touchstart` event is detected on a `<Link>`.
     *
     * If `'viewport'`, routes will be preloaded by default when they are within the viewport.
     *
     * @default false
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpreload-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/preloading)
     */
    defaultPreload?: false | 'intent' | 'viewport' | 'render';
    /**
     * The delay in milliseconds that a route must be hovered over or touched before it is preloaded.
     *
     * @default 50
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpreloaddelay-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/preloading#preload-delay)
     */
    defaultPreloadDelay?: number;
    /**
     * The default `preloadIntentProximity` a route should use if no preloadIntentProximity is provided.
     *
     * @default 0
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpreloadintentproximity-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/preloading#preload-intent-proximity)
     */
    defaultPreloadIntentProximity?: number;
    /**
     * The default `pendingMs` a route should use if no pendingMs is provided.
     *
     * @default 1000
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpendingms-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#avoiding-pending-component-flash)
     */
    defaultPendingMs?: number;
    /**
     * The default `pendingMinMs` a route should use if no pendingMinMs is provided.
     *
     * @default 500
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpendingminms-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#avoiding-pending-component-flash)
     */
    defaultPendingMinMs?: number;
    /**
     * The default `staleTime` a route should use if no staleTime is provided. This is the time in milliseconds that a route will be considered fresh.
     *
     * @default 0
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultstaletime-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#key-options)
     */
    defaultStaleTime?: number;
    /**
     * The default `preloadStaleTime` a route should use if no preloadStaleTime is provided.
     *
     * @default 30_000 `(30 seconds)`
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpreloadstaletime-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/preloading)
     */
    defaultPreloadStaleTime?: number;
    /**
     * The default `defaultPreloadGcTime` a route should use if no preloadGcTime is provided.
     *
     * @default 1_800_000 `(30 minutes)`
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultpreloadgctime-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/preloading)
     */
    defaultPreloadGcTime?: number;
    /**
     * If `true`, route navigations will called using `document.startViewTransition()`.
     *
     * If the browser does not support this api, this option will be ignored.
     *
     * See [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition) for more information on how this function works.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultviewtransition-property)
     */
    defaultViewTransition?: boolean | ViewTransitionOptions;
    /**
     * The default `hashScrollIntoView` a route should use if no hashScrollIntoView is provided while navigating
     *
     * See [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollIntoView) for more information on `ScrollIntoViewOptions`.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaulthashscrollintoview-property)
     */
    defaultHashScrollIntoView?: boolean | ScrollIntoViewOptions;
    /**
     * @default 'fuzzy'
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#notfoundmode-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/not-found-errors#the-notfoundmode-option)
     */
    notFoundMode?: 'root' | 'fuzzy';
    /**
     * The default `gcTime` a route should use if no gcTime is provided.
     *
     * @default 1_800_000 `(30 minutes)`
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultgctime-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#key-options)
     */
    defaultGcTime?: number;
    /**
     * If `true`, all routes will be matched as case-sensitive.
     *
     * @default false
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#casesensitive-property)
     */
    caseSensitive?: boolean;
    /**
     *
     * The route tree that will be used to configure the router instance.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#routetree-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/routing/route-trees)
     */
    routeTree?: TRouteTree;
    /**
     * The basepath for then entire router. This is useful for mounting a router instance at a subpath.
     * ```
     * @default '/'
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#basepath-property)
     */
    basepath?: string;
    /**
     * The root context that will be provided to all routes in the route tree.
     *
     * This can be used to provide a context to all routes in the tree without having to provide it to each route individually.
     *
     * Optional or required if the root route was created with [`createRootRouteWithContext()`](https://tanstack.com/router/latest/docs/framework/react/api/router/createRootRouteWithContextFunction).
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#context-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/router-context)
     */
    context?: InferRouterContext<TRouteTree>;
    additionalContext?: any;
    /**
     * A function that will be called when the router is dehydrated.
     *
     * The return value of this function will be serialized and stored in the router's dehydrated state.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#dehydrate-method)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading#critical-dehydrationhydration)
     */
    dehydrate?: () => Constrain<TDehydrated, ValidateSerializableInput<Register, TDehydrated>>;
    /**
     * A function that will be called when the router is hydrated.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#hydrate-method)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading#critical-dehydrationhydration)
     */
    hydrate?: (dehydrated: TDehydrated) => Awaitable<void>;
    /**
     * An array of route masks that will be used to mask routes in the route tree.
     *
     * Route masking is when you display a route at a different path than the one it is configured to match, like a modal popup that when shared will unmask to the modal's content instead of the modal's context.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#routemasks-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/route-masking)
     */
    routeMasks?: Array<RouteMask<TRouteTree>>;
    /**
     * If `true`, route masks will, by default, be removed when the page is reloaded.
     *
     * This can be overridden on a per-mask basis by setting the `unmaskOnReload` option on the mask, or on a per-navigation basis by setting the `unmaskOnReload` option in the `Navigate` options.
     *
     * @default false
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#unmaskonreload-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/route-masking#unmasking-on-page-reload)
     */
    unmaskOnReload?: boolean;
    /**
     * Use `notFoundComponent` instead.
     *
     * @deprecated
     * See https://tanstack.com/router/v1/docs/guide/not-found-errors#migrating-from-notfoundroute for more info.
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#notfoundroute-property)
     */
    notFoundRoute?: AnyRoute;
    /**
     * Configures how trailing slashes are treated.
     *
     * - `'always'` will add a trailing slash if not present
     * - `'never'` will remove the trailing slash if present
     * - `'preserve'` will not modify the trailing slash.
     *
     * @default 'never'
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#trailingslash-property)
     */
    trailingSlash?: TTrailingSlashOption;
    /**
     * While usually automatic, sometimes it can be useful to force the router into a server-side state, e.g. when using the router in a non-browser environment that has access to a global.document object.
     *
     * @default typeof document !== 'undefined'
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#isserver-property)
     */
    isServer?: boolean;
    /**
     * @default false
     */
    isShell?: boolean;
    /**
     * @default false
     */
    isPrerendering?: boolean;
    /**
     * The default `ssr` a route should use if no `ssr` is provided.
     *
     * @default true
     */
    defaultSsr?: SSROption;
    search?: {
        /**
         * Configures how unknown search params (= not returned by any `validateSearch`) are treated.
         *
         * @default false
         * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#search.strict-property)
         */
        strict?: boolean;
    };
    /**
     * Configures whether structural sharing is enabled by default for fine-grained selectors.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#defaultstructuralsharing-property)
     */
    defaultStructuralSharing?: TDefaultStructuralSharingOption;
    /**
     * Configures which URI characters are allowed in path params that would ordinarily be escaped by encodeURIComponent.
     *
     * @link [API Docs](https://tanstack.com/router/latest/docs/framework/react/api/router/RouterOptionsType#pathparamsallowedcharacters-property)
     * @link [Guide](https://tanstack.com/router/latest/docs/framework/react/guide/path-params#allowed-characters)
     */
    pathParamsAllowedCharacters?: Array<';' | ':' | '@' | '&' | '=' | '+' | '$' | ','>;
    defaultRemountDeps?: DefaultRemountDepsFn<TRouteTree>;
    /**
     * If `true`, scroll restoration will be enabled
     *
     * @default false
     */
    scrollRestoration?: boolean | ((opts: {
        location: ParsedLocation;
    }) => boolean);
    /**
     * A function that will be called to get the key for the scroll restoration cache.
     *
     * @default (location) => location.href
     */
    getScrollRestorationKey?: (location: ParsedLocation) => string;
    /**
     * The default behavior for scroll restoration.
     *
     * @default 'auto'
     */
    scrollRestorationBehavior?: ScrollBehavior;
    /**
     * An array of selectors that will be used to scroll to the top of the page in addition to `window`
     *
     * @default ['window']
     */
    scrollToTopSelectors?: Array<string | (() => Element | null | undefined)>;
    /**
     * When `true`, disables the global catch boundary that normally wraps all route matches.
     * This allows unhandled errors to bubble up to top-level error handlers in the browser.
     *
     * Useful for testing tools (like Storybook Test Runner), error reporting services,
     * and debugging scenarios where you want errors to reach the browser's global error handlers.
     *
     * @default false
     */
    disableGlobalCatchBoundary?: boolean;
    serializationAdapters?: ReadonlyArray<AnySerializationAdapter>;
    /**
     * Configures how the router will rewrite the location between the actual href and the internal href of the router.
     *
     * @default undefined
     * @description You can provide a custom rewrite pair (in/out).
     * This is useful for shifting data from the origin to the path (for things like subdomain routing), or other advanced use cases.
     */
    rewrite?: LocationRewrite;
    origin?: string;
    ssr?: {
        nonce?: string;
    };
}
export type LocationRewrite = {
    /**
     * A function that will be called to rewrite the URL before it is interpreted by the router from the history instance.
     *
     * @default undefined
     */
    input?: LocationRewriteFunction;
    /**
     * A function that will be called to rewrite the URL before it is committed to the actual history instance from the router.
     *
     * @default undefined
     */
    output?: LocationRewriteFunction;
};
/**
 * A function that will be called to rewrite the URL.
 *
 * @param url The URL to rewrite.
 * @returns The rewritten URL (as a URL instance or full href string) or undefined if no rewrite is needed.
 */
export type LocationRewriteFunction = ({ url, }: {
    url: URL;
}) => undefined | string | URL;
export interface RouterState<in out TRouteTree extends AnyRoute = AnyRoute, in out TRouteMatch = MakeRouteMatchUnion> {
    status: 'pending' | 'idle';
    loadedAt: number;
    isLoading: boolean;
    isTransitioning: boolean;
    matches: Array<TRouteMatch>;
    pendingMatches?: Array<TRouteMatch>;
    cachedMatches: Array<TRouteMatch>;
    location: ParsedLocation<FullSearchSchema<TRouteTree>>;
    resolvedLocation?: ParsedLocation<FullSearchSchema<TRouteTree>>;
    statusCode: number;
    redirect?: AnyRedirect;
}
export interface BuildNextOptions {
    to?: string | number | null;
    params?: true | Updater<unknown>;
    search?: true | Updater<unknown>;
    hash?: true | Updater<string>;
    state?: true | NonNullableUpdater<ParsedHistoryState, HistoryState>;
    mask?: {
        to?: string | number | null;
        params?: true | Updater<unknown>;
        search?: true | Updater<unknown>;
        hash?: true | Updater<string>;
        state?: true | NonNullableUpdater<ParsedHistoryState, HistoryState>;
        unmaskOnReload?: boolean;
    };
    from?: string;
    href?: string;
    _fromLocation?: ParsedLocation;
    unsafeRelative?: 'path';
    _isNavigate?: boolean;
}
type NavigationEventInfo = {
    fromLocation?: ParsedLocation;
    toLocation: ParsedLocation;
    pathChanged: boolean;
    hrefChanged: boolean;
    hashChanged: boolean;
};
export interface RouterEvents {
    onBeforeNavigate: {
        type: 'onBeforeNavigate';
    } & NavigationEventInfo;
    onBeforeLoad: {
        type: 'onBeforeLoad';
    } & NavigationEventInfo;
    onLoad: {
        type: 'onLoad';
    } & NavigationEventInfo;
    onResolved: {
        type: 'onResolved';
    } & NavigationEventInfo;
    onBeforeRouteMount: {
        type: 'onBeforeRouteMount';
    } & NavigationEventInfo;
    onRendered: {
        type: 'onRendered';
    } & NavigationEventInfo;
}
export type RouterEvent = RouterEvents[keyof RouterEvents];
export type ListenerFn<TEvent extends RouterEvent> = (event: TEvent) => void;
export type RouterListener<TRouterEvent extends RouterEvent> = {
    eventType: TRouterEvent['type'];
    fn: ListenerFn<TRouterEvent>;
};
export type SubscribeFn = <TType extends keyof RouterEvents>(eventType: TType, fn: ListenerFn<RouterEvents[TType]>) => () => void;
export interface MatchRoutesOpts {
    preload?: boolean;
    throwOnError?: boolean;
    _buildLocation?: boolean;
    dest?: BuildNextOptions;
}
export type InferRouterContext<TRouteTree extends AnyRoute> = TRouteTree['types']['routerContext'];
export type RouterContextOptions<TRouteTree extends AnyRoute> = AnyContext extends InferRouterContext<TRouteTree> ? {
    context?: InferRouterContext<TRouteTree>;
} : {
    context: InferRouterContext<TRouteTree>;
};
export type RouterConstructorOptions<TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption, TDefaultStructuralSharingOption extends boolean, TRouterHistory extends RouterHistory, TDehydrated extends Record<string, any>> = Omit<RouterOptions<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>, 'context' | 'serializationAdapters' | 'defaultSsr'> & RouterContextOptions<TRouteTree>;
export type PreloadRouteFn<TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption, TDefaultStructuralSharingOption extends boolean, TRouterHistory extends RouterHistory> = <TFrom extends RoutePaths<TRouteTree> | string = string, TTo extends string | undefined = undefined, TMaskFrom extends RoutePaths<TRouteTree> | string = TFrom, TMaskTo extends string = ''>(opts: NavigateOptions<RouterCore<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory>, TFrom, TTo, TMaskFrom, TMaskTo>) => Promise<Array<AnyRouteMatch> | undefined>;
export type MatchRouteFn<TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption, TDefaultStructuralSharingOption extends boolean, TRouterHistory extends RouterHistory> = <TFrom extends RoutePaths<TRouteTree> = '/', TTo extends string | undefined = undefined, TResolved = ResolveRelativePath<TFrom, NoInfer<TTo>>>(location: ToOptions<RouterCore<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory>, TFrom, TTo>, opts?: MatchRouteOptions) => false | RouteById<TRouteTree, TResolved>['types']['allParams'];
export type UpdateFn<TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption, TDefaultStructuralSharingOption extends boolean, TRouterHistory extends RouterHistory, TDehydrated extends Record<string, any>> = (newOptions: RouterConstructorOptions<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>) => void;
export type InvalidateFn<TRouter extends AnyRouter> = (opts?: {
    filter?: (d: MakeRouteMatchUnion<TRouter>) => boolean;
    sync?: boolean;
    forcePending?: boolean;
}) => Promise<void>;
export type ParseLocationFn<TRouteTree extends AnyRoute> = (locationToParse: HistoryLocation, previousLocation?: ParsedLocation<FullSearchSchema<TRouteTree>>) => ParsedLocation<FullSearchSchema<TRouteTree>>;
export type GetMatchRoutesFn = (pathname: string) => {
    matchedRoutes: ReadonlyArray<AnyRoute>;
    /** exhaustive params, still in their string form */
    routeParams: Record<string, string>;
    /** partial params, parsed from routeParams during matching */
    parsedParams: Record<string, unknown> | undefined;
    foundRoute: AnyRoute | undefined;
    parseError?: unknown;
};
export type EmitFn = (routerEvent: RouterEvent) => void;
export type LoadFn = (opts?: {
    sync?: boolean;
}) => Promise<void>;
export type CommitLocationFn = ({ viewTransition, ignoreBlocker, ...next }: ParsedLocation & CommitLocationOptions) => Promise<void>;
export type StartTransitionFn = (fn: () => void) => void;
export interface MatchRoutesFn {
    (pathname: string, locationSearch?: AnySchema, opts?: MatchRoutesOpts): Array<MakeRouteMatchUnion>;
    /**
     * @deprecated use the following signature instead
     */
    (next: ParsedLocation, opts?: MatchRoutesOpts): Array<AnyRouteMatch>;
    (pathnameOrNext: string | ParsedLocation, locationSearchOrOpts?: AnySchema | MatchRoutesOpts, opts?: MatchRoutesOpts): Array<AnyRouteMatch>;
}
export type GetMatchFn = (matchId: string) => AnyRouteMatch | undefined;
export type UpdateMatchFn = (id: string, updater: (match: AnyRouteMatch) => AnyRouteMatch) => void;
export type LoadRouteChunkFn = (route: AnyRoute) => Promise<Array<void>>;
export type ResolveRedirect = (err: AnyRedirect) => ResolvedRedirect;
export type ClearCacheFn<TRouter extends AnyRouter> = (opts?: {
    filter?: (d: MakeRouteMatchUnion<TRouter>) => boolean;
}) => void;
export interface ServerSsr {
    /**
     * Injects HTML synchronously into the stream.
     * Emits an onInjectedHtml event that listeners can handle.
     * If no subscriber is listening, the HTML is buffered and can be retrieved via takeBufferedHtml().
     */
    injectHtml: (html: string) => void;
    /**
     * Injects a script tag synchronously into the stream.
     */
    injectScript: (script: string) => void;
    isDehydrated: () => boolean;
    isSerializationFinished: () => boolean;
    onRenderFinished: (listener: () => void) => void;
    onSerializationFinished: (listener: () => void) => void;
    dehydrate: () => Promise<void>;
    takeBufferedScripts: () => RouterManagedTag | undefined;
    /**
     * Takes any buffered HTML that was injected.
     * Returns the buffered HTML string (which may include multiple script tags) or undefined if empty.
     */
    takeBufferedHtml: () => string | undefined;
    liftScriptBarrier: () => void;
}
export type AnyRouterWithContext<TContext> = RouterCore<AnyRouteWithContext<TContext>, any, any, any, any>;
export type AnyRouter = RouterCore<any, any, any, any, any>;
export interface ViewTransitionOptions {
    types: Array<string> | ((locationChangeInfo: {
        fromLocation?: ParsedLocation;
        toLocation: ParsedLocation;
        pathChanged: boolean;
        hrefChanged: boolean;
        hashChanged: boolean;
    }) => Array<string> | false);
}
/**
 * Convert an unknown error into a minimal, serializable object.
 * Includes name and message (and stack in development).
 */
export declare function defaultSerializeError(err: unknown): {
    name: string;
    message: string;
} | {
    data: unknown;
};
/** Options for configuring trailing-slash behavior. */
export declare const trailingSlashOptions: {
    readonly always: "always";
    readonly never: "never";
    readonly preserve: "preserve";
};
export type TrailingSlashOption = (typeof trailingSlashOptions)[keyof typeof trailingSlashOptions];
/**
 * Compute whether path, href or hash changed between previous and current
 * resolved locations in router state.
 */
export declare function getLocationChangeInfo(routerState: {
    resolvedLocation?: ParsedLocation;
    location: ParsedLocation;
}): {
    fromLocation: ParsedLocation<{}> | undefined;
    toLocation: ParsedLocation<{}>;
    pathChanged: boolean;
    hrefChanged: boolean;
    hashChanged: boolean;
};
export type CreateRouterFn = <TRouteTree extends AnyRoute, TTrailingSlashOption extends TrailingSlashOption = 'never', TDefaultStructuralSharingOption extends boolean = false, TRouterHistory extends RouterHistory = RouterHistory, TDehydrated extends Record<string, any> = Record<string, any>>(options: undefined extends number ? 'strictNullChecks must be enabled in tsconfig.json' : RouterConstructorOptions<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>) => RouterCore<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>;
/**
 * Core, framework-agnostic router engine that powers TanStack Router.
 *
 * Provides navigation, matching, loading, preloading, caching and event APIs
 * used by framework adapters (React/Solid). Prefer framework helpers like
 * `createRouter` in app code.
 *
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType
 */
export declare class RouterCore<in out TRouteTree extends AnyRoute, in out TTrailingSlashOption extends TrailingSlashOption, in out TDefaultStructuralSharingOption extends boolean, in out TRouterHistory extends RouterHistory = RouterHistory, in out TDehydrated extends Record<string, any> = Record<string, any>> {
    tempLocationKey: string | undefined;
    resetNextScroll: boolean;
    shouldViewTransition?: boolean | ViewTransitionOptions;
    isViewTransitionTypesSupported?: boolean;
    subscribers: Set<RouterListener<RouterEvent>>;
    viewTransitionPromise?: ControlledPromise<true>;
    isScrollRestoring: boolean;
    isScrollRestorationSetup: boolean;
    __store: Store<RouterState<TRouteTree>>;
    options: PickAsRequired<RouterOptions<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>, 'stringifySearch' | 'parseSearch' | 'context'>;
    history: TRouterHistory;
    rewrite?: LocationRewrite;
    origin?: string;
    latestLocation: ParsedLocation<FullSearchSchema<TRouteTree>>;
    pendingBuiltLocation?: ParsedLocation<FullSearchSchema<TRouteTree>>;
    basepath: string;
    routeTree: TRouteTree;
    routesById: RoutesById<TRouteTree>;
    routesByPath: RoutesByPath<TRouteTree>;
    processedTree: ProcessedTree<TRouteTree, any, any>;
    isServer: boolean;
    pathParamsDecodeCharMap?: Map<string, string>;
    /**
     * @deprecated Use the `createRouter` function instead
     */
    constructor(options: RouterConstructorOptions<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>);
    startTransition: StartTransitionFn;
    isShell(): boolean;
    isPrerendering(): boolean;
    update: UpdateFn<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>;
    get state(): RouterState<TRouteTree>;
    updateLatestLocation: () => void;
    buildRouteTree: () => void;
    /**
     * Subscribe to router lifecycle events like `onBeforeNavigate`, `onLoad`,
     * `onResolved`, etc. Returns an unsubscribe function.
     *
     * @link https://tanstack.com/router/latest/docs/framework/react/api/router/RouterEventsType
     */
    subscribe: SubscribeFn;
    emit: EmitFn;
    /**
     * Parse a HistoryLocation into a strongly-typed ParsedLocation using the
     * current router options, rewrite rules and search parser/stringifier.
     */
    parseLocation: ParseLocationFn<TRouteTree>;
    resolvePathCache: import('./lru-cache.cjs').LRUCache<string, string>;
    /** Resolve a path against the router basepath and trailing-slash policy. */
    resolvePathWithBase: (from: string, path: string) => string;
    get looseRoutesById(): Record<string, AnyRoute>;
    matchRoutes: MatchRoutesFn;
    private matchRoutesInternal;
    getMatchedRoutes: GetMatchRoutesFn;
    cancelMatch: (id: string) => void;
    cancelMatches: () => void;
    /**
     * Build the next ParsedLocation from navigation options without committing.
     * Resolves `to`/`from`, params/search/hash/state, applies search validation
     * and middlewares, and returns a stable, stringified location object.
     *
     * @link https://tanstack.com/router/latest/docs/framework/react/api/router/RouterType#buildlocation-method
     */
    buildLocation: BuildLocationFn;
    commitLocationPromise: undefined | ControlledPromise<void>;
    /**
     * Commit a previously built location to history (push/replace), optionally
     * using view transitions and scroll restoration options.
     */
    commitLocation: CommitLocationFn;
    /** Convenience helper: build a location from options, then commit it. */
    buildAndCommitLocation: ({ replace, resetScroll, hashScrollIntoView, viewTransition, ignoreBlocker, href, ...rest }?: BuildNextOptions & CommitLocationOptions) => Promise<void>;
    /**
     * Imperatively navigate using standard `NavigateOptions`. When `reloadDocument`
     * or an absolute `href` is provided, performs a full document navigation.
     * Otherwise, builds and commits a client-side location.
     *
     * @link https://tanstack.com/router/latest/docs/framework/react/api/router/NavigateOptionsType
     */
    navigate: NavigateFn;
    latestLoadPromise: undefined | Promise<void>;
    beforeLoad: () => void;
    load: LoadFn;
    startViewTransition: (fn: () => Promise<void>) => void;
    updateMatch: UpdateMatchFn;
    getMatch: GetMatchFn;
    /**
     * Invalidate the current matches and optionally force them back into a pending state.
     *
     * - Marks all matches that pass the optional `filter` as `invalid: true`.
     * - If `forcePending` is true, or a match is currently in `'error'` or `'notFound'` status,
     *   its status is reset to `'pending'` and its `error` cleared so that the loader is re-run
     *   on the next `load()` call (eg. after HMR or a manual invalidation).
     */
    invalidate: InvalidateFn<RouterCore<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory, TDehydrated>>;
    getParsedLocationHref: (location: ParsedLocation) => string;
    resolveRedirect: (redirect: AnyRedirect) => AnyRedirect;
    clearCache: ClearCacheFn<this>;
    clearExpiredCache: () => void;
    loadRouteChunk: typeof loadRouteChunk;
    preloadRoute: PreloadRouteFn<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory>;
    matchRoute: MatchRouteFn<TRouteTree, TTrailingSlashOption, TDefaultStructuralSharingOption, TRouterHistory>;
    ssr?: {
        manifest: Manifest | undefined;
    };
    serverSsr?: ServerSsr;
    hasNotFoundMatch: () => boolean;
}
/** Error thrown when search parameter validation fails. */
export declare class SearchParamError extends Error {
}
/** Error thrown when path parameter parsing/validation fails. */
export declare class PathParamError extends Error {
}
/**
 * Lazily import a module function and forward arguments to it, retaining
 * parameter and return types for the selected export key.
 */
export declare function lazyFn<T extends Record<string, (...args: Array<any>) => any>, TKey extends keyof T = 'default'>(fn: () => Promise<T>, key?: TKey): (...args: Parameters<T[TKey]>) => Promise<Awaited<ReturnType<T[TKey]>>>;
/** Create an initial RouterState from a parsed location. */
export declare function getInitialRouterState(location: ParsedLocation): RouterState<any>;
/**
 * Build the matched route chain and extract params for a pathname.
 * Falls back to the root route if no specific route is found.
 */
export declare function getMatchedRoutes<TRouteLike extends RouteLike>({ pathname, routesById, processedTree, }: {
    pathname: string;
    routesById: Record<string, TRouteLike>;
    processedTree: ProcessedTree<any, any, any>;
}): {
    matchedRoutes: readonly TRouteLike[];
    routeParams: Record<string, string>;
    foundRoute: TRouteLike | undefined;
    parsedParams: Record<string, unknown> | undefined;
};
export {};
