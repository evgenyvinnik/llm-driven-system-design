import { ParsedLocation, ScrollRestorationEntry, ScrollRestorationOptions } from '@tanstack/router-core';
/**
 * @deprecated Use the `scrollRestoration` router option instead.
 */
export declare function ScrollRestoration(_props: ScrollRestorationOptions): null;
export declare function useElementScrollRestoration(options: ({
    id: string;
    getElement?: () => Window | Element | undefined | null;
} | {
    id?: string;
    getElement: () => Window | Element | undefined | null;
}) & {
    getKey?: (location: ParsedLocation) => string;
}): ScrollRestorationEntry | undefined;
