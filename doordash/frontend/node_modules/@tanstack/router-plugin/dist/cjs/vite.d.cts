import { configSchema, CodeSplittingOptions, Config, getConfig } from './core/config.cjs';
declare const tanstackRouterAutoImport: (options?: Partial<{
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
} | (() => Config)> | undefined) => import('vite').Plugin<any> | import('vite').Plugin<any>[];
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   plugins: [tanstackRouterGenerator()],
 *   // ...
 * })
 * ```
 */
declare const tanstackRouterGenerator: (options?: Partial<{
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
} | (() => Config)> | undefined) => import('vite').Plugin<any> | import('vite').Plugin<any>[];
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   plugins: [tanStackRouterCodeSplitter()],
 *   // ...
 * })
 * ```
 */
declare const tanStackRouterCodeSplitter: (options?: Partial<{
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
} | (() => Config)> | undefined) => import('vite').Plugin<any> | import('vite').Plugin<any>[];
/**
 * @example
 * ```ts
 * export default defineConfig({
 *   plugins: [tanstackRouter()],
 *   // ...
 * })
 * ```
 */
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
}> | undefined) => import('vite').Plugin<any> | import('vite').Plugin<any>[];
/**
 * @deprecated Use `tanstackRouter` instead.
 */
declare const TanStackRouterVite: (options?: Partial<{
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
}> | undefined) => import('vite').Plugin<any> | import('vite').Plugin<any>[];
export default tanstackRouter;
export { configSchema, getConfig, tanstackRouterAutoImport, tanStackRouterCodeSplitter, tanstackRouterGenerator, TanStackRouterVite, tanstackRouter, };
export type { Config, CodeSplittingOptions };
