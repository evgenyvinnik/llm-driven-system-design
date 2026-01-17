import { defaultSerializeError } from './router.cjs';
/**
 * Well-known symbol used by {@link defer} to tag a promise with
 * its deferred state. Consumers can read `promise[TSR_DEFERRED_PROMISE]`
 * to access `status`, `data`, or `error`.
 */
export declare const TSR_DEFERRED_PROMISE: unique symbol;
export type DeferredPromiseState<T> = {
    status: 'pending';
    data?: T;
    error?: unknown;
} | {
    status: 'success';
    data: T;
} | {
    status: 'error';
    data?: T;
    error: unknown;
};
export type DeferredPromise<T> = Promise<T> & {
    [TSR_DEFERRED_PROMISE]: DeferredPromiseState<T>;
};
/**
 * Wrap a promise with a deferred state for use with `<Await>` and `useAwaited`.
 *
 * The returned promise is augmented with internal state (status/data/error)
 * so UI can read progress or suspend until it settles.
 *
 * @param _promise The promise to wrap.
 * @param options Optional config. Provide `serializeError` to customize how
 * errors are serialized for transfer.
 * @returns The same promise with attached deferred metadata.
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/deferFunction
 */
export declare function defer<T>(_promise: Promise<T>, options?: {
    serializeError?: typeof defaultSerializeError;
}): DeferredPromise<T>;
