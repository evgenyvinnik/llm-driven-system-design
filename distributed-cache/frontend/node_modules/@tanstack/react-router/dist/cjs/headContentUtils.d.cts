import { RouterManagedTag } from '@tanstack/router-core';
/**
 * Build the list of head/link/meta/script tags to render for active matches.
 * Used internally by `HeadContent`.
 */
export declare const useTags: () => RouterManagedTag[];
export declare function uniqBy<T>(arr: Array<T>, fn: (item: T) => string): T[];
