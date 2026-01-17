import { RouteIds } from './routeInfo.cjs';
import { AnyRouter } from './router.cjs';
export type Awaitable<T> = T | Promise<T>;
export type NoInfer<T> = [T][T extends any ? 0 : never];
export type IsAny<TValue, TYesResult, TNoResult = TValue> = 1 extends 0 & TValue ? TYesResult : TNoResult;
export type PickAsRequired<TValue, TKey extends keyof TValue> = Omit<TValue, TKey> & Required<Pick<TValue, TKey>>;
export type PickRequired<T> = {
    [K in keyof T as undefined extends T[K] ? never : K]: T[K];
};
export type PickOptional<T> = {
    [K in keyof T as undefined extends T[K] ? K : never]: T[K];
};
export type WithoutEmpty<T> = T extends any ? ({} extends T ? never : T) : never;
export type Expand<T> = T extends object ? T extends infer O ? O extends Function ? O : {
    [K in keyof O]: O[K];
} : never : T;
export type DeepPartial<T> = T extends object ? {
    [P in keyof T]?: DeepPartial<T[P]>;
} : T;
export type MakeDifferenceOptional<TLeft, TRight> = keyof TLeft & keyof TRight extends never ? TRight : Omit<TRight, keyof TLeft & keyof TRight> & {
    [K in keyof TLeft & keyof TRight]?: TRight[K];
};
export type IsUnion<T, U extends T = T> = (T extends any ? (U extends T ? false : true) : never) extends false ? false : true;
export type IsNonEmptyObject<T> = T extends object ? keyof T extends never ? false : true : false;
export type Assign<TLeft, TRight> = TLeft extends any ? TRight extends any ? IsNonEmptyObject<TLeft> extends false ? TRight : IsNonEmptyObject<TRight> extends false ? TLeft : keyof TLeft & keyof TRight extends never ? TLeft & TRight : Omit<TLeft, keyof TRight> & TRight : never : never;
export type IntersectAssign<TLeft, TRight> = TLeft extends any ? TRight extends any ? IsNonEmptyObject<TLeft> extends false ? TRight : IsNonEmptyObject<TRight> extends false ? TLeft : TRight & TLeft : never : never;
export type Timeout = ReturnType<typeof setTimeout>;
export type Updater<TPrevious, TResult = TPrevious> = TResult | ((prev?: TPrevious) => TResult);
export type NonNullableUpdater<TPrevious, TResult = TPrevious> = TResult | ((prev: TPrevious) => TResult);
export type ExtractObjects<TUnion> = TUnion extends MergeAllPrimitive ? never : TUnion;
export type PartialMergeAllObject<TUnion> = ExtractObjects<TUnion> extends infer TObj ? [TObj] extends [never] ? never : {
    [TKey in TObj extends any ? keyof TObj : never]?: TObj extends any ? TKey extends keyof TObj ? TObj[TKey] : never : never;
} : never;
export type MergeAllPrimitive = ReadonlyArray<any> | number | string | bigint | boolean | symbol | undefined | null;
export type ExtractPrimitives<TUnion> = TUnion extends MergeAllPrimitive ? TUnion : TUnion extends object ? never : TUnion;
export type PartialMergeAll<TUnion> = ExtractPrimitives<TUnion> | PartialMergeAllObject<TUnion>;
export type Constrain<T, TConstraint, TDefault = TConstraint> = (T extends TConstraint ? T : never) | TDefault;
export type ConstrainLiteral<T, TConstraint, TDefault = TConstraint> = (T & TConstraint) | TDefault;
/**
 * To be added to router types
 */
export type UnionToIntersection<T> = (T extends any ? (arg: T) => any : never) extends (arg: infer T) => any ? T : never;
/**
 * Merges everything in a union into one object.
 * This mapped type is homomorphic which means it preserves stuff! :)
 */
export type MergeAllObjects<TUnion, TIntersected = UnionToIntersection<ExtractObjects<TUnion>>> = [keyof TIntersected] extends [never] ? never : {
    [TKey in keyof TIntersected]: TUnion extends any ? TUnion[TKey & keyof TUnion] : never;
};
export type MergeAll<TUnion> = MergeAllObjects<TUnion> | ExtractPrimitives<TUnion>;
export type ValidateJSON<T> = ((...args: Array<any>) => any) extends T ? unknown extends T ? never : 'Function is not serializable' : {
    [K in keyof T]: ValidateJSON<T[K]>;
};
export type LooseReturnType<T> = T extends (...args: Array<any>) => infer TReturn ? TReturn : never;
export type LooseAsyncReturnType<T> = T extends (...args: Array<any>) => infer TReturn ? TReturn extends Promise<infer TReturn> ? TReturn : TReturn : never;
/**
 * Return the last element of an array.
 * Intended for non-empty arrays used within router internals.
 */
export declare function last<T>(arr: Array<T>): T | undefined;
/**
 * Apply a value-or-updater to a previous value.
 * Accepts either a literal value or a function of the previous value.
 */
export declare function functionalUpdate<TPrevious, TResult = TPrevious>(updater: Updater<TPrevious, TResult> | NonNullableUpdater<TPrevious, TResult>, previous: TPrevious): TResult;
/**
 * This function returns `prev` if `_next` is deeply equal.
 * If not, it will replace any deeply equal children of `b` with those of `a`.
 * This can be used for structural sharing between immutable JSON values for example.
 * Do not use this with signals
 */
export declare function replaceEqualDeep<T>(prev: any, _next: T, _depth?: number): T;
export declare function isPlainObject(o: any): boolean;
/**
 * Check if a value is a "plain" array (no extra enumerable keys).
 */
export declare function isPlainArray(value: unknown): value is Array<unknown>;
/**
 * Perform a deep equality check with options for partial comparison and
 * ignoring `undefined` values. Optimized for router state comparisons.
 */
export declare function deepEqual(a: any, b: any, opts?: {
    partial?: boolean;
    ignoreUndefined?: boolean;
}): boolean;
export type StringLiteral<T> = T extends string ? string extends T ? string : T : never;
export type ThrowOrOptional<T, TThrow extends boolean> = TThrow extends true ? T : T | undefined;
export type StrictOrFrom<TRouter extends AnyRouter, TFrom, TStrict extends boolean = true> = TStrict extends false ? {
    from?: never;
    strict: TStrict;
} : {
    from: ConstrainLiteral<TFrom, RouteIds<TRouter['routeTree']>>;
    strict?: TStrict;
};
export type ThrowConstraint<TStrict extends boolean, TThrow extends boolean> = TStrict extends false ? (TThrow extends true ? never : TThrow) : TThrow;
export type ControlledPromise<T> = Promise<T> & {
    resolve: (value: T) => void;
    reject: (value: any) => void;
    status: 'pending' | 'resolved' | 'rejected';
    value?: T;
};
/**
 * Create a promise with exposed resolve/reject and status fields.
 * Useful for coordinating async router lifecycle operations.
 */
export declare function createControlledPromise<T>(onResolve?: (value: T) => void): ControlledPromise<T>;
/**
 * Heuristically detect dynamic import "module not found" errors
 * across major browsers for lazy route component handling.
 */
export declare function isModuleNotFoundError(error: any): boolean;
export declare function isPromise<T>(value: Promise<Awaited<T>> | T): value is Promise<Awaited<T>>;
export declare function findLast<T>(array: ReadonlyArray<T>, predicate: (item: T) => boolean): T | undefined;
/**
 * List of URL protocols that are safe for navigation.
 * Only these protocols are allowed in redirects and navigation.
 */
export declare const SAFE_URL_PROTOCOLS: string[];
/**
 * Check if a URL string uses a protocol that is not in the safe list.
 * Returns true for dangerous protocols like javascript:, data:, vbscript:, etc.
 *
 * The URL constructor correctly normalizes:
 * - Mixed case (JavaScript: → javascript:)
 * - Whitespace/control characters (java\nscript: → javascript:)
 * - Leading whitespace
 *
 * For relative URLs (no protocol), returns false (safe).
 *
 * @param url - The URL string to check
 * @returns true if the URL uses a dangerous (non-whitelisted) protocol
 */
export declare function isDangerousProtocol(url: string): boolean;
/**
 * Escape HTML special characters in a string to prevent XSS attacks
 * when embedding strings in script tags during SSR.
 *
 * This is essential for preventing XSS vulnerabilities when user-controlled
 * content is embedded in inline scripts.
 */
export declare function escapeHtml(str: string): string;
export declare function decodePath(path: string, decodeIgnore?: Array<string>): string;
/**
 * Builds the dev-mode CSS styles URL for route-scoped CSS collection.
 * Used by HeadContent components in all framework implementations to construct
 * the URL for the `/@tanstack-start/styles.css` endpoint.
 *
 * @param basepath - The router's basepath (may or may not have leading slash)
 * @param routeIds - Array of matched route IDs to include in the CSS collection
 * @returns The full URL path for the dev styles CSS endpoint
 */
export declare function buildDevStylesUrl(basepath: string, routeIds: Array<string>): string;
