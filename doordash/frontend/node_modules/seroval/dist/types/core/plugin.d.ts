import type { AsyncParsePluginContext } from './context/async-parser';
import type { DeserializePluginContext } from './context/deserializer';
import type { SerializePluginContext } from './context/serializer';
import type { StreamParsePluginContext, SyncParsePluginContext } from './context/sync-parser';
export declare const enum SerovalMode {
    Vanilla = 1,
    Cross = 2
}
export interface PluginData {
    id: number;
}
export interface Plugin<Value, Node> {
    /**
     * A unique string that helps idenfity the plugin
     */
    tag: string;
    /**
     * List of dependency plugins
     */
    extends?: Plugin<any, any>[];
    /**
     * Method to test if a value is an expected value of the plugin
     * @param value
     */
    test(value: unknown): boolean;
    /**
     * Parsing modes
     */
    parse: {
        sync?: (value: Value, ctx: SyncParsePluginContext, data: PluginData) => Node;
        async?: (value: Value, ctx: AsyncParsePluginContext, data: PluginData) => Promise<Node>;
        stream?: (value: Value, ctx: StreamParsePluginContext, data: PluginData) => Node;
    };
    /**
     * Convert the parsed node into a JS string
     */
    serialize(node: Node, ctx: SerializePluginContext, data: PluginData): string;
    /**
     * Convert the parsed node into its runtime equivalent.
     */
    deserialize(node: Node, ctx: DeserializePluginContext, data: PluginData): Value;
}
export declare function createPlugin<Value, Node>(plugin: Plugin<Value, Node>): Plugin<Value, Node>;
export interface PluginAccessOptions {
    plugins?: Plugin<any, any>[];
}
export declare function resolvePlugins(plugins?: Plugin<any, any>[]): Plugin<any, any>[] | undefined;
//# sourceMappingURL=plugin.d.ts.map