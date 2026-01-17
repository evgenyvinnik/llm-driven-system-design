import { HandleNodeAccumulator, RouteNode } from '../types.cjs';
import { Generator } from '../generator.cjs';
export interface GeneratorPlugin {
    name: string;
    init?: (opts: {
        generator: Generator;
    }) => void;
    onRouteTreeChanged?: (opts: {
        routeTree: Array<RouteNode>;
        routeNodes: Array<RouteNode>;
        rootRouteNode: RouteNode;
        acc: HandleNodeAccumulator;
    }) => void;
    afterTransform?: (opts: {
        node: RouteNode;
        prevNode: RouteNode | undefined;
    }) => void;
}
