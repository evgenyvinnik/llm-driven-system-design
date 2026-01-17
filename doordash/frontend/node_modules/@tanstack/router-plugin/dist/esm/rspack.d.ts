import { configSchema, CodeSplittingOptions, Config } from './core/config.js';
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   // ...
 *   tools: {
 *     rspack: {
 *       plugins: [TanStackRouterGeneratorRspack()],
 *     },
 *   },
 * })
 * ```
 */
declare const TanStackRouterGeneratorRspack: (options?: Partial<{
    target: "react" | "solid" | "vue";
    routeFileIgnorePrefix: string;
    routesDirectory: string;
    quoteStyle: "single" | "double";
    semicolons: boolean;
    disableLogging: boolean;
    routeTreeFileHeader: string[];
    indexToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    routeToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    generatedRouteTree: string;
    disableTypes: boolean;
    addExtensions: boolean;
    enableRouteTreeFormatting: boolean;
    tmpDir: string;
    importRoutesUsingAbsolutePaths: boolean;
    enableRouteGeneration?: boolean | undefined;
    codeSplittingOptions?: CodeSplittingOptions | undefined;
    plugin?: {
        vite?: {
            environmentName?: string | undefined;
        } | undefined;
    } | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (";" | ":" | "@" | "&" | "=" | "+" | "$" | ",")[] | undefined;
    verboseFileRoutes?: boolean | undefined;
    routeTreeFileFooter?: string[] | ((...args: unknown[]) => string[]) | undefined;
    autoCodeSplitting?: boolean | undefined;
    customScaffolding?: {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    } | undefined;
    experimental?: {
        enableCodeSplitting?: boolean | undefined;
    } | undefined;
    plugins?: import('@tanstack/router-generator').GeneratorPlugin[] | undefined;
} | (() => Config)> | undefined) => import('unplugin').RspackPluginInstance;
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   // ...
 *   tools: {
 *     rspack: {
 *       plugins: [TanStackRouterCodeSplitterRspack()],
 *     },
 *   },
 * })
 * ```
 */
declare const TanStackRouterCodeSplitterRspack: (options?: Partial<{
    target: "react" | "solid" | "vue";
    routeFileIgnorePrefix: string;
    routesDirectory: string;
    quoteStyle: "single" | "double";
    semicolons: boolean;
    disableLogging: boolean;
    routeTreeFileHeader: string[];
    indexToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    routeToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    generatedRouteTree: string;
    disableTypes: boolean;
    addExtensions: boolean;
    enableRouteTreeFormatting: boolean;
    tmpDir: string;
    importRoutesUsingAbsolutePaths: boolean;
    enableRouteGeneration?: boolean | undefined;
    codeSplittingOptions?: CodeSplittingOptions | undefined;
    plugin?: {
        vite?: {
            environmentName?: string | undefined;
        } | undefined;
    } | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (";" | ":" | "@" | "&" | "=" | "+" | "$" | ",")[] | undefined;
    verboseFileRoutes?: boolean | undefined;
    routeTreeFileFooter?: string[] | ((...args: unknown[]) => string[]) | undefined;
    autoCodeSplitting?: boolean | undefined;
    customScaffolding?: {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    } | undefined;
    experimental?: {
        enableCodeSplitting?: boolean | undefined;
    } | undefined;
    plugins?: import('@tanstack/router-generator').GeneratorPlugin[] | undefined;
} | (() => Config)> | undefined) => import('unplugin').RspackPluginInstance;
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   // ...
 *   tools: {
 *     rspack: {
 *       plugins: [tanstackRouter()],
 *     },
 *   },
 * })
 * ```
 */
declare const TanStackRouterRspack: (options?: Partial<{
    target: "react" | "solid" | "vue";
    routeFileIgnorePrefix: string;
    routesDirectory: string;
    quoteStyle: "single" | "double";
    semicolons: boolean;
    disableLogging: boolean;
    routeTreeFileHeader: string[];
    indexToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    routeToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    generatedRouteTree: string;
    disableTypes: boolean;
    addExtensions: boolean;
    enableRouteTreeFormatting: boolean;
    tmpDir: string;
    importRoutesUsingAbsolutePaths: boolean;
    enableRouteGeneration?: boolean | undefined;
    codeSplittingOptions?: CodeSplittingOptions | undefined;
    plugin?: {
        vite?: {
            environmentName?: string | undefined;
        } | undefined;
    } | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (";" | ":" | "@" | "&" | "=" | "+" | "$" | ",")[] | undefined;
    verboseFileRoutes?: boolean | undefined;
    routeTreeFileFooter?: string[] | ((...args: unknown[]) => string[]) | undefined;
    autoCodeSplitting?: boolean | undefined;
    customScaffolding?: {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    } | undefined;
    experimental?: {
        enableCodeSplitting?: boolean | undefined;
    } | undefined;
    plugins?: import('@tanstack/router-generator').GeneratorPlugin[] | undefined;
}> | undefined) => import('unplugin').RspackPluginInstance;
declare const tanstackRouter: (options?: Partial<{
    target: "react" | "solid" | "vue";
    routeFileIgnorePrefix: string;
    routesDirectory: string;
    quoteStyle: "single" | "double";
    semicolons: boolean;
    disableLogging: boolean;
    routeTreeFileHeader: string[];
    indexToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    routeToken: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    };
    generatedRouteTree: string;
    disableTypes: boolean;
    addExtensions: boolean;
    enableRouteTreeFormatting: boolean;
    tmpDir: string;
    importRoutesUsingAbsolutePaths: boolean;
    enableRouteGeneration?: boolean | undefined;
    codeSplittingOptions?: CodeSplittingOptions | undefined;
    plugin?: {
        vite?: {
            environmentName?: string | undefined;
        } | undefined;
    } | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (";" | ":" | "@" | "&" | "=" | "+" | "$" | ",")[] | undefined;
    verboseFileRoutes?: boolean | undefined;
    routeTreeFileFooter?: string[] | ((...args: unknown[]) => string[]) | undefined;
    autoCodeSplitting?: boolean | undefined;
    customScaffolding?: {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    } | undefined;
    experimental?: {
        enableCodeSplitting?: boolean | undefined;
    } | undefined;
    plugins?: import('@tanstack/router-generator').GeneratorPlugin[] | undefined;
}> | undefined) => import('unplugin').RspackPluginInstance;
export default TanStackRouterRspack;
export { configSchema, TanStackRouterRspack, TanStackRouterGeneratorRspack, TanStackRouterCodeSplitterRspack, tanstackRouter, };
export type { Config, CodeSplittingOptions };
