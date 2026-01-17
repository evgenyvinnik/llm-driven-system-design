import { IndexRoute, LayoutRoute, PhysicalSubtree, Route, VirtualRootRoute, VirtualRouteNode } from './types.js';
export declare function rootRoute(file: string, children?: Array<VirtualRouteNode>): VirtualRootRoute;
export declare function index(file: string): IndexRoute;
export declare function layout(file: string, children: Array<VirtualRouteNode>): LayoutRoute;
export declare function layout(id: string, file: string, children: Array<VirtualRouteNode>): LayoutRoute;
export declare function route(path: string, children: Array<VirtualRouteNode>): Route;
export declare function route(path: string, file: string): Route;
export declare function route(path: string, file: string, children: Array<VirtualRouteNode>): Route;
/**
 * Mount a physical directory of route files at a given path prefix.
 *
 * @param pathPrefix - The path prefix to mount the directory at. Use empty string '' to merge routes at the current level.
 * @param directory - The directory containing the route files, relative to the routes directory.
 */
export declare function physical(pathPrefix: string, directory: string): PhysicalSubtree;
/**
 * Mount a physical directory of route files at the current level (empty path prefix).
 * This is equivalent to `physical('', directory)`.
 *
 * @param directory - The directory containing the route files, relative to the routes directory.
 */
export declare function physical(directory: string): PhysicalSubtree;
