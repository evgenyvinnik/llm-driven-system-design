import { StructuralSharingOption, ValidateSelected } from './structuralSharing.js';
import { AnyRouter, RegisteredRouter, ResolveUseParams, StrictOrFrom, ThrowConstraint, ThrowOrOptional, UseParamsResult } from '@tanstack/router-core';
export interface UseParamsBaseOptions<TRouter extends AnyRouter, TFrom, TStrict extends boolean, TThrow extends boolean, TSelected, TStructuralSharing> {
    select?: (params: ResolveUseParams<TRouter, TFrom, TStrict>) => ValidateSelected<TRouter, TSelected, TStructuralSharing>;
    shouldThrow?: TThrow;
}
export type UseParamsOptions<TRouter extends AnyRouter, TFrom extends string | undefined, TStrict extends boolean, TThrow extends boolean, TSelected, TStructuralSharing> = StrictOrFrom<TRouter, TFrom, TStrict> & UseParamsBaseOptions<TRouter, TFrom, TStrict, TThrow, TSelected, TStructuralSharing> & StructuralSharingOption<TRouter, TSelected, TStructuralSharing>;
export type UseParamsRoute<out TFrom> = <TRouter extends AnyRouter = RegisteredRouter, TSelected = unknown, TStructuralSharing extends boolean = boolean>(opts?: UseParamsBaseOptions<TRouter, TFrom, true, true, TSelected, TStructuralSharing> & StructuralSharingOption<TRouter, TSelected, TStructuralSharing>) => UseParamsResult<TRouter, TFrom, true, TSelected>;
/**
 * Access the current route's path parameters with type-safety.
 *
 * Options:
 * - `from`/`strict`: Specify the matched route and whether to enforce strict typing
 * - `select`: Project the params object to a derived value for memoized renders
 * - `structuralSharing`: Enable structural sharing for stable references
 * - `shouldThrow`: Throw if the route is not found in strict contexts
 *
 * @returns The params object (or selected value) for the matched route.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/useParamsHook
 */
export declare function useParams<TRouter extends AnyRouter = RegisteredRouter, const TFrom extends string | undefined = undefined, TStrict extends boolean = true, TThrow extends boolean = true, TSelected = unknown, TStructuralSharing extends boolean = boolean>(opts: UseParamsOptions<TRouter, TFrom, TStrict, ThrowConstraint<TStrict, TThrow>, TSelected, TStructuralSharing>): ThrowOrOptional<UseParamsResult<TRouter, TFrom, TStrict, TSelected>, TThrow>;
