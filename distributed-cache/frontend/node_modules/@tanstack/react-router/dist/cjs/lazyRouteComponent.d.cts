import { AsyncRouteComponent } from './route.cjs';
/**
 * Wrap a dynamic import to create a route component that supports
 * `.preload()` and friendly reload-on-module-missing behavior.
 *
 * @param importer Function returning a module promise
 * @param exportName Named export to use (default: `default`)
 * @returns A lazy route component compatible with TanStack Router
 * @link https://tanstack.com/router/latest/docs/framework/react/api/router/lazyRouteComponentFunction
 */
export declare function lazyRouteComponent<T extends Record<string, any>, TKey extends keyof T = 'default'>(importer: () => Promise<T>, exportName?: TKey): T[TKey] extends (props: infer TProps) => any ? AsyncRouteComponent<TProps> : never;
