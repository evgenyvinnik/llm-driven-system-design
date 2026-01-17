import { AnySchema } from './validators.cjs';
/** Default `parseSearch` that strips leading '?' and JSON-parses values. */
export declare const defaultParseSearch: (searchStr: string) => AnySchema;
/** Default `stringifySearch` using JSON.stringify for complex values. */
export declare const defaultStringifySearch: (search: Record<string, any>) => string;
/**
 * Build a `parseSearch` function using a provided JSON-like parser.
 *
 * The returned function strips a leading `?`, decodes values, and attempts to
 * JSON-parse string values using the given `parser`.
 *
 * @param parser Function to parse a string value (e.g. `JSON.parse`).
 * @returns A `parseSearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
export declare function parseSearchWith(parser: (str: string) => any): (searchStr: string) => AnySchema;
/**
 * Build a `stringifySearch` function using a provided serializer.
 *
 * Non-primitive values are serialized with `stringify`. If a `parser` is
 * supplied, string values that are parseable are re-serialized to ensure
 * symmetry with `parseSearch`.
 *
 * @param stringify Function to serialize a value (e.g. `JSON.stringify`).
 * @param parser Optional parser to detect parseable strings.
 * @returns A `stringifySearch` function compatible with `Router` options.
 * @link https://tanstack.com/router/latest/docs/framework/react/guide/custom-search-param-serialization
 */
export declare function stringifySearchWith(stringify: (search: any) => string, parser?: (str: string) => any): (search: Record<string, any>) => string;
export type SearchSerializer = (searchObj: Record<string, any>) => string;
export type SearchParser = (searchStr: string) => Record<string, any>;
