import { z } from 'zod';
import { GeneratorPlugin } from './plugin/types.cjs';
declare const tokenJsonRegexSchema: z.ZodObject<{
    regex: z.ZodString;
    flags: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    regex: string;
    flags?: string | undefined;
}, {
    regex: string;
    flags?: string | undefined;
}>;
declare const tokenMatcherSchema: z.ZodUnion<[z.ZodString, z.ZodType<RegExp, z.ZodTypeDef, RegExp>, z.ZodObject<{
    regex: z.ZodString;
    flags: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    regex: string;
    flags?: string | undefined;
}, {
    regex: string;
    flags?: string | undefined;
}>]>;
export type TokenMatcherJson = string | z.infer<typeof tokenJsonRegexSchema>;
export type TokenMatcher = z.infer<typeof tokenMatcherSchema>;
export declare const baseConfigSchema: z.ZodObject<{
    target: z.ZodDefault<z.ZodOptional<z.ZodEnum<["react", "solid", "vue"]>>>;
    virtualRouteConfig: z.ZodOptional<z.ZodUnion<[z.ZodType<import('@tanstack/virtual-file-routes').VirtualRootRoute, z.ZodTypeDef, import('@tanstack/virtual-file-routes').VirtualRootRoute>, z.ZodString]>>;
    routeFilePrefix: z.ZodOptional<z.ZodString>;
    routeFileIgnorePrefix: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    routeFileIgnorePattern: z.ZodOptional<z.ZodString>;
    routesDirectory: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    quoteStyle: z.ZodDefault<z.ZodOptional<z.ZodEnum<["single", "double"]>>>;
    semicolons: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    disableLogging: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    routeTreeFileHeader: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    indexToken: z.ZodDefault<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodType<RegExp, z.ZodTypeDef, RegExp>, z.ZodObject<{
        regex: z.ZodString;
        flags: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        regex: string;
        flags?: string | undefined;
    }, {
        regex: string;
        flags?: string | undefined;
    }>]>>>;
    routeToken: z.ZodDefault<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodType<RegExp, z.ZodTypeDef, RegExp>, z.ZodObject<{
        regex: z.ZodString;
        flags: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        regex: string;
        flags?: string | undefined;
    }, {
        regex: string;
        flags?: string | undefined;
    }>]>>>;
    pathParamsAllowedCharacters: z.ZodOptional<z.ZodArray<z.ZodEnum<[";", ":", "@", "&", "=", "+", "$", ","]>, "many">>;
}, "strip", z.ZodTypeAny, {
    target: "vue" | "react" | "solid";
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
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (":" | "$" | ";" | "@" | "&" | "=" | "+" | ",")[] | undefined;
}, {
    target?: "vue" | "react" | "solid" | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    routesDirectory?: string | undefined;
    quoteStyle?: "single" | "double" | undefined;
    semicolons?: boolean | undefined;
    disableLogging?: boolean | undefined;
    routeTreeFileHeader?: string[] | undefined;
    indexToken?: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    } | undefined;
    routeToken?: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    } | undefined;
    pathParamsAllowedCharacters?: (":" | "$" | ";" | "@" | "&" | "=" | "+" | ",")[] | undefined;
}>;
export type BaseConfig = z.infer<typeof baseConfigSchema>;
export declare const configSchema: z.ZodObject<{
    target: z.ZodDefault<z.ZodOptional<z.ZodEnum<["react", "solid", "vue"]>>>;
    virtualRouteConfig: z.ZodOptional<z.ZodUnion<[z.ZodType<import('@tanstack/virtual-file-routes').VirtualRootRoute, z.ZodTypeDef, import('@tanstack/virtual-file-routes').VirtualRootRoute>, z.ZodString]>>;
    routeFilePrefix: z.ZodOptional<z.ZodString>;
    routeFileIgnorePrefix: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    routeFileIgnorePattern: z.ZodOptional<z.ZodString>;
    routesDirectory: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    quoteStyle: z.ZodDefault<z.ZodOptional<z.ZodEnum<["single", "double"]>>>;
    semicolons: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    disableLogging: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    routeTreeFileHeader: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    indexToken: z.ZodDefault<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodType<RegExp, z.ZodTypeDef, RegExp>, z.ZodObject<{
        regex: z.ZodString;
        flags: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        regex: string;
        flags?: string | undefined;
    }, {
        regex: string;
        flags?: string | undefined;
    }>]>>>;
    routeToken: z.ZodDefault<z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodType<RegExp, z.ZodTypeDef, RegExp>, z.ZodObject<{
        regex: z.ZodString;
        flags: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        regex: string;
        flags?: string | undefined;
    }, {
        regex: string;
        flags?: string | undefined;
    }>]>>>;
    pathParamsAllowedCharacters: z.ZodOptional<z.ZodArray<z.ZodEnum<[";", ":", "@", "&", "=", "+", "$", ","]>, "many">>;
} & {
    generatedRouteTree: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    disableTypes: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    verboseFileRoutes: z.ZodOptional<z.ZodBoolean>;
    addExtensions: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    enableRouteTreeFormatting: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    routeTreeFileFooter: z.ZodOptional<z.ZodUnion<[z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>, z.ZodFunction<z.ZodTuple<[], z.ZodUnknown>, z.ZodArray<z.ZodString, "many">>]>>;
    autoCodeSplitting: z.ZodOptional<z.ZodBoolean>;
    customScaffolding: z.ZodOptional<z.ZodObject<{
        routeTemplate: z.ZodOptional<z.ZodString>;
        lazyRouteTemplate: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    }, {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    }>>;
    experimental: z.ZodOptional<z.ZodObject<{
        enableCodeSplitting: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enableCodeSplitting?: boolean | undefined;
    }, {
        enableCodeSplitting?: boolean | undefined;
    }>>;
    plugins: z.ZodOptional<z.ZodArray<z.ZodType<GeneratorPlugin, z.ZodTypeDef, GeneratorPlugin>, "many">>;
    tmpDir: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    importRoutesUsingAbsolutePaths: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    target: "vue" | "react" | "solid";
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
    plugins?: GeneratorPlugin[] | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    pathParamsAllowedCharacters?: (":" | "$" | ";" | "@" | "&" | "=" | "+" | ",")[] | undefined;
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
}, {
    plugins?: GeneratorPlugin[] | undefined;
    target?: "vue" | "react" | "solid" | undefined;
    virtualRouteConfig?: string | import('@tanstack/virtual-file-routes').VirtualRootRoute | undefined;
    routeFilePrefix?: string | undefined;
    routeFileIgnorePrefix?: string | undefined;
    routeFileIgnorePattern?: string | undefined;
    routesDirectory?: string | undefined;
    quoteStyle?: "single" | "double" | undefined;
    semicolons?: boolean | undefined;
    disableLogging?: boolean | undefined;
    routeTreeFileHeader?: string[] | undefined;
    indexToken?: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    } | undefined;
    routeToken?: string | RegExp | {
        regex: string;
        flags?: string | undefined;
    } | undefined;
    pathParamsAllowedCharacters?: (":" | "$" | ";" | "@" | "&" | "=" | "+" | ",")[] | undefined;
    generatedRouteTree?: string | undefined;
    disableTypes?: boolean | undefined;
    verboseFileRoutes?: boolean | undefined;
    addExtensions?: boolean | undefined;
    enableRouteTreeFormatting?: boolean | undefined;
    routeTreeFileFooter?: string[] | ((...args: unknown[]) => string[]) | undefined;
    autoCodeSplitting?: boolean | undefined;
    customScaffolding?: {
        routeTemplate?: string | undefined;
        lazyRouteTemplate?: string | undefined;
    } | undefined;
    experimental?: {
        enableCodeSplitting?: boolean | undefined;
    } | undefined;
    tmpDir?: string | undefined;
    importRoutesUsingAbsolutePaths?: boolean | undefined;
}>;
export type Config = z.infer<typeof configSchema>;
type ResolveParams = {
    configDirectory: string;
};
export declare function resolveConfigPath({ configDirectory }: ResolveParams): string;
export declare function getConfig(inlineConfig?: Partial<Config>, configDirectory?: string): Config;
export {};
