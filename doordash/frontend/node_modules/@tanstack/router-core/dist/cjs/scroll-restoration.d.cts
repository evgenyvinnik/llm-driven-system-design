import { AnyRouter } from './router.cjs';
import { ParsedLocation } from './location.cjs';
import { NonNullableUpdater } from './utils.cjs';
import { HistoryLocation } from '@tanstack/history';
export type ScrollRestorationEntry = {
    scrollX: number;
    scrollY: number;
};
export type ScrollRestorationByElement = Record<string, ScrollRestorationEntry>;
export type ScrollRestorationByKey = Record<string, ScrollRestorationByElement>;
export type ScrollRestorationCache = {
    state: ScrollRestorationByKey;
    set: (updater: NonNullableUpdater<ScrollRestorationByKey>) => void;
};
export type ScrollRestorationOptions = {
    getKey?: (location: ParsedLocation) => string;
    scrollBehavior?: ScrollToOptions['behavior'];
};
/** SessionStorage key used to persist scroll restoration state. */
/** SessionStorage key used to store scroll positions across navigations. */
/** SessionStorage key used to store scroll positions across navigations. */
export declare const storageKey = "tsr-scroll-restoration-v1_3";
/** In-memory handle to the persisted scroll restoration cache. */
export declare const scrollRestorationCache: ScrollRestorationCache | null;
/**
 * The default `getKey` function for `useScrollRestoration`.
 * It returns the `key` from the location state or the `href` of the location.
 *
 * The `location.href` is used as a fallback to support the use case where the location state is not available like the initial render.
 */
/**
 * Default scroll restoration cache key: location state key or full href.
 */
export declare const defaultGetScrollRestorationKey: (location: ParsedLocation) => string;
/** Best-effort nth-child CSS selector for a given element. */
export declare function getCssSelector(el: any): string;
export declare function restoreScroll({ storageKey, key, behavior, shouldScrollRestoration, scrollToTopSelectors, location, }: {
    storageKey: string;
    key?: string;
    behavior?: ScrollToOptions['behavior'];
    shouldScrollRestoration?: boolean;
    scrollToTopSelectors?: Array<string | (() => Element | null | undefined)>;
    location?: HistoryLocation;
}): void;
/** Setup global listeners and hooks to support scroll restoration. */
/** Setup global listeners and hooks to support scroll restoration. */
export declare function setupScrollRestoration(router: AnyRouter, force?: boolean): void;
/**
 * @private
 * Handles hash-based scrolling after navigation completes.
 * To be used in framework-specific <Transitioner> components during the onResolved event.
 *
 * Provides hash scrolling for programmatic navigation when default browser handling is prevented.
 * @param router The router instance containing current location and state
 */
/**
 * @private
 * Handles hash-based scrolling after navigation completes.
 * To be used in framework-specific Transitioners.
 */
export declare function handleHashScroll(router: AnyRouter): void;
