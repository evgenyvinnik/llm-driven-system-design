import { NoInfer, PickOptional } from './utils.js';
import { SearchMiddleware } from './route.js';
import { IsRequiredParams } from './link.js';
/**
 * Retain specified search params across navigations.
 *
 * If `keys` is `true`, retain all current params. Otherwise, copy only the
 * listed keys from the current search into the next search.
 *
 * @param keys `true` to retain all, or a list of keys to retain.
 * @returns A search middleware suitable for route `search.middlewares`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/retainSearchParamsFunction
 */
export declare function retainSearchParams<TSearchSchema extends object>(keys: Array<keyof TSearchSchema> | true): SearchMiddleware<TSearchSchema>;
/**
 * Remove optional or default-valued search params from navigations.
 *
 * - Pass `true` (only if there are no required search params) to strip all.
 * - Pass an array to always remove those optional keys.
 * - Pass an object of default values; keys equal (deeply) to the defaults are removed.
 *
 * @returns A search middleware suitable for route `search.middlewares`.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/stripSearchParamsFunction
 */
export declare function stripSearchParams<TSearchSchema, TOptionalProps = PickOptional<NoInfer<TSearchSchema>>, const TValues = Partial<NoInfer<TOptionalProps>> | Array<keyof TOptionalProps>, const TInput = IsRequiredParams<TSearchSchema> extends never ? TValues | true : TValues>(input: NoInfer<TInput>): SearchMiddleware<TSearchSchema>;
