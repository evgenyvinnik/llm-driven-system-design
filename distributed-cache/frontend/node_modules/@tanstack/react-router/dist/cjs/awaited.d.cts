import * as React from 'react';
export type AwaitOptions<T> = {
    promise: Promise<T>;
};
/** Suspend until a deferred promise resolves or rejects and return its data. */
export declare function useAwaited<T>({ promise: _promise }: AwaitOptions<T>): T;
/**
 * Component that suspends on a deferred promise and renders its child with
 * the resolved value. Optionally provides a Suspense fallback.
 */
export declare function Await<T>(props: AwaitOptions<T> & {
    fallback?: React.ReactNode;
    children: (result: T) => React.ReactNode;
}): import("react/jsx-runtime").JSX.Element;
