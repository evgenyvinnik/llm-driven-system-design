import { LocationRewrite } from './router.js';
/** Compose multiple rewrite pairs into a single in/out rewrite. */
/** Compose multiple rewrite pairs into a single in/out rewrite. */
export declare function composeRewrites(rewrites: Array<LocationRewrite>): {
    input: ({ url }: {
        url: URL;
    }) => URL;
    output: ({ url }: {
        url: URL;
    }) => URL;
};
/** Create a rewrite pair that strips/adds a basepath on input/output. */
/** Create a rewrite pair that strips/adds a basepath on input/output. */
export declare function rewriteBasepath(opts: {
    basepath: string;
    caseSensitive?: boolean;
}): {
    input: ({ url }: {
        url: URL;
    }) => URL;
    output: ({ url }: {
        url: URL;
    }) => URL;
};
/** Execute a location input rewrite if provided. */
/** Execute a location input rewrite if provided. */
export declare function executeRewriteInput(rewrite: LocationRewrite | undefined, url: URL): URL;
/** Execute a location output rewrite if provided. */
/** Execute a location output rewrite if provided. */
export declare function executeRewriteOutput(rewrite: LocationRewrite | undefined, url: URL): URL;
