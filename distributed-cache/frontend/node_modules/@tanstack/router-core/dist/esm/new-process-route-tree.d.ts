import { LRUCache } from './lru-cache.js';
export declare const SEGMENT_TYPE_PATHNAME = 0;
export declare const SEGMENT_TYPE_PARAM = 1;
export declare const SEGMENT_TYPE_WILDCARD = 2;
export declare const SEGMENT_TYPE_OPTIONAL_PARAM = 3;
declare const SEGMENT_TYPE_INDEX = 4;
declare const SEGMENT_TYPE_PATHLESS = 5;
/**
 * All the kinds of segments that can be present in a route path.
 */
export type SegmentKind = typeof SEGMENT_TYPE_PATHNAME | typeof SEGMENT_TYPE_PARAM | typeof SEGMENT_TYPE_WILDCARD | typeof SEGMENT_TYPE_OPTIONAL_PARAM;
/**
 * All the kinds of segments that can be present in the segment tree.
 */
type ExtendedSegmentKind = SegmentKind | typeof SEGMENT_TYPE_INDEX | typeof SEGMENT_TYPE_PATHLESS;
type ParsedSegment = Uint16Array & {
    /** segment type (0 = pathname, 1 = param, 2 = wildcard, 3 = optional param) */
    0: SegmentKind;
    /** index of the end of the prefix */
    1: number;
    /** index of the start of the value */
    2: number;
    /** index of the end of the value */
    3: number;
    /** index of the start of the suffix */
    4: number;
    /** index of the end of the segment */
    5: number;
};
/**
 * Populates the `output` array with the parsed representation of the given `segment` string.
 *
 * Usage:
 * ```ts
 * let output
 * let cursor = 0
 * while (cursor < path.length) {
 *   output = parseSegment(path, cursor, output)
 *   const end = output[5]
 *   cursor = end + 1
 * ```
 *
 * `output` is stored outside to avoid allocations during repeated calls. It doesn't need to be typed
 * or initialized, it will be done automatically.
 */
export declare function parseSegment(
/** The full path string containing the segment. */
path: string, 
/** The starting index of the segment within the path. */
start: number, 
/** A Uint16Array (length: 6) to populate with the parsed segment data. */
output?: Uint16Array): ParsedSegment;
type StaticSegmentNode<T extends RouteLike> = SegmentNode<T> & {
    kind: typeof SEGMENT_TYPE_PATHNAME | typeof SEGMENT_TYPE_PATHLESS | typeof SEGMENT_TYPE_INDEX;
};
type DynamicSegmentNode<T extends RouteLike> = SegmentNode<T> & {
    kind: typeof SEGMENT_TYPE_PARAM | typeof SEGMENT_TYPE_WILDCARD | typeof SEGMENT_TYPE_OPTIONAL_PARAM;
    prefix?: string;
    suffix?: string;
    caseSensitive: boolean;
};
type AnySegmentNode<T extends RouteLike> = StaticSegmentNode<T> | DynamicSegmentNode<T>;
type SegmentNode<T extends RouteLike> = {
    kind: ExtendedSegmentKind;
    pathless: Array<StaticSegmentNode<T>> | null;
    /** Exact index segment (highest priority) */
    index: StaticSegmentNode<T> | null;
    /** Static segments (2nd priority) */
    static: Map<string, StaticSegmentNode<T>> | null;
    /** Case insensitive static segments (3rd highest priority) */
    staticInsensitive: Map<string, StaticSegmentNode<T>> | null;
    /** Dynamic segments ($param) */
    dynamic: Array<DynamicSegmentNode<T>> | null;
    /** Optional dynamic segments ({-$param}) */
    optional: Array<DynamicSegmentNode<T>> | null;
    /** Wildcard segments ($ - lowest priority) */
    wildcard: Array<DynamicSegmentNode<T>> | null;
    /** Terminal route (if this path can end here) */
    route: T | null;
    /** The full path for this segment node (will only be valid on leaf nodes) */
    fullPath: string;
    parent: AnySegmentNode<T> | null;
    depth: number;
    /** route.options.params.parse function, set on the last node of the route */
    parse: null | ((params: Record<string, string>) => any);
    /** options.skipRouteOnParseError.params ?? false */
    skipOnParamError: boolean;
    /** options.skipRouteOnParseError.priority ?? 0 */
    parsingPriority: number;
};
type RouteLike = {
    id?: string;
    path?: string;
    children?: Array<RouteLike>;
    parentRoute?: RouteLike;
    isRoot?: boolean;
    options?: {
        skipRouteOnParseError?: {
            params?: boolean;
            priority?: number;
        };
        caseSensitive?: boolean;
        params?: {
            parse?: (params: Record<string, string>) => any;
        };
    };
} & ({
    fullPath: string;
    from?: never;
} | {
    fullPath?: never;
    from: string;
});
export type ProcessedTree<TTree extends Extract<RouteLike, {
    fullPath: string;
}>, TFlat extends Extract<RouteLike, {
    from: string;
}>, TSingle extends Extract<RouteLike, {
    from: string;
}>> = {
    /** a representation of the `routeTree` as a segment tree */
    segmentTree: AnySegmentNode<TTree>;
    /** a mini route tree generated from the flat `routeMasks` list */
    masksTree: AnySegmentNode<TFlat> | null;
    /** @deprecated keep until v2 so that `router.matchRoute` can keep not caring about the actual route tree */
    singleCache: LRUCache<string, AnySegmentNode<TSingle>>;
    /** a cache of route matches from the `segmentTree` */
    matchCache: LRUCache<string, RouteMatch<TTree> | null>;
    /** a cache of route matches from the `masksTree` */
    flatCache: LRUCache<string, ReturnType<typeof findMatch<TFlat>>> | null;
};
export declare function processRouteMasks<TRouteLike extends Extract<RouteLike, {
    from: string;
}>>(routeList: Array<TRouteLike>, processedTree: ProcessedTree<any, TRouteLike, any>): void;
/**
 * Take an arbitrary list of routes, create a tree from them (if it hasn't been created already), and match a path against it.
 */
export declare function findFlatMatch<T extends Extract<RouteLike, {
    from: string;
}>>(
/** The path to match. */
path: string, 
/** The `processedTree` returned by the initial `processRouteTree` call. */
processedTree: ProcessedTree<any, T, any>): {
    route: T;
    /**
     * The raw (unparsed) params extracted from the path.
     * This will be the exhaustive list of all params defined in the route's path.
     */
    rawParams: Record<string, string>;
    /**
     * The accumlulated parsed params of each route in the branch that had `skipRouteOnParseError` enabled.
     * Will not contain all params defined in the route's path. Those w/ a `params.parse` but no `skipRouteOnParseError` will need to be parsed separately.
     */
    parsedParams?: Record<string, unknown>;
} | null;
/**
 * @deprecated keep until v2 so that `router.matchRoute` can keep not caring about the actual route tree
 */
export declare function findSingleMatch(from: string, caseSensitive: boolean, fuzzy: boolean, path: string, processedTree: ProcessedTree<any, any, {
    from: string;
}>): {
    route: {
        from: string;
    };
    /**
     * The raw (unparsed) params extracted from the path.
     * This will be the exhaustive list of all params defined in the route's path.
     */
    rawParams: Record<string, string>;
    /**
     * The accumlulated parsed params of each route in the branch that had `skipRouteOnParseError` enabled.
     * Will not contain all params defined in the route's path. Those w/ a `params.parse` but no `skipRouteOnParseError` will need to be parsed separately.
     */
    parsedParams?: Record<string, unknown>;
} | null;
type RouteMatch<T extends Extract<RouteLike, {
    fullPath: string;
}>> = {
    route: T;
    rawParams: Record<string, string>;
    parsedParams?: Record<string, unknown>;
    branch: ReadonlyArray<T>;
};
export declare function findRouteMatch<T extends Extract<RouteLike, {
    fullPath: string;
}>>(
/** The path to match against the route tree. */
path: string, 
/** The `processedTree` returned by the initial `processRouteTree` call. */
processedTree: ProcessedTree<T, any, any>, 
/** If `true`, allows fuzzy matching (partial matches), i.e. which node in the tree would have been an exact match if the `path` had been shorter? */
fuzzy?: boolean): RouteMatch<T> | null;
/** Trim trailing slashes (except preserving root '/'). */
export declare function trimPathRight(path: string): string;
/**
 * Processes a route tree into a segment trie for efficient path matching.
 * Also builds lookup maps for routes by ID and by trimmed full path.
 */
export declare function processRouteTree<TRouteLike extends Extract<RouteLike, {
    fullPath: string;
}> & {
    id: string;
}>(
/** The root of the route tree to process. */
routeTree: TRouteLike, 
/** Whether matching should be case sensitive by default (overridden by individual route options). */
caseSensitive?: boolean, 
/** Optional callback invoked for each route during processing. */
initRoute?: (route: TRouteLike, index: number) => void): {
    /** Should be considered a black box, needs to be provided to all matching functions in this module. */
    processedTree: ProcessedTree<TRouteLike, any, any>;
    /** A lookup map of routes by their unique IDs. */
    routesById: Record<string, TRouteLike>;
    /** A lookup map of routes by their trimmed full paths. */
    routesByPath: Record<string, TRouteLike>;
};
declare function findMatch<T extends RouteLike>(path: string, segmentTree: AnySegmentNode<T>, fuzzy?: boolean): {
    route: T;
    /**
     * The raw (unparsed) params extracted from the path.
     * This will be the exhaustive list of all params defined in the route's path.
     */
    rawParams: Record<string, string>;
    /**
     * The accumlulated parsed params of each route in the branch that had `skipRouteOnParseError` enabled.
     * Will not contain all params defined in the route's path. Those w/ a `params.parse` but no `skipRouteOnParseError` will need to be parsed separately.
     */
    parsedParams?: Record<string, unknown>;
} | null;
export {};
