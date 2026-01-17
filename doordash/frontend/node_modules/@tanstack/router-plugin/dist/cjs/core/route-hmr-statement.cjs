"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const template = require("@babel/template");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const template__namespace = /* @__PURE__ */ _interopNamespaceDefault(template);
function handleRouteUpdate(oldRoute, newRoute) {
  newRoute._path = oldRoute._path;
  newRoute._id = oldRoute._id;
  newRoute._fullPath = oldRoute._fullPath;
  newRoute._to = oldRoute._to;
  newRoute.children = oldRoute.children;
  newRoute.parentRoute = oldRoute.parentRoute;
  const router = window.__TSR_ROUTER__;
  router.routesById[newRoute.id] = newRoute;
  router.routesByPath[newRoute.fullPath] = newRoute;
  router.processedTree.matchCache.clear();
  router.processedTree.flatCache?.clear();
  router.processedTree.singleCache.clear();
  router.resolvePathCache.clear();
  walkReplaceSegmentTree(newRoute, router.processedTree.segmentTree);
  const filter = (m) => m.routeId === oldRoute.id;
  if (router.state.matches.find(filter) || router.state.pendingMatches?.find(filter)) {
    router.invalidate({ filter });
  }
  function walkReplaceSegmentTree(route, node) {
    if (node.route?.id === route.id) node.route = route;
    if (node.index) walkReplaceSegmentTree(route, node.index);
    node.static?.forEach((child) => walkReplaceSegmentTree(route, child));
    node.staticInsensitive?.forEach(
      (child) => walkReplaceSegmentTree(route, child)
    );
    node.dynamic?.forEach((child) => walkReplaceSegmentTree(route, child));
    node.optional?.forEach((child) => walkReplaceSegmentTree(route, child));
    node.wildcard?.forEach((child) => walkReplaceSegmentTree(route, child));
  }
}
const routeHmrStatement = template__namespace.statement(
  `
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (Route && newModule && newModule.Route) {
      (${handleRouteUpdate.toString()})(Route, newModule.Route)
    }
   })
}
`,
  // Disable placeholder parsing so identifiers like __TSR_ROUTER__ are treated as normal identifiers instead of template placeholders
  { placeholderPattern: false }
)();
exports.routeHmrStatement = routeHmrStatement;
//# sourceMappingURL=route-hmr-statement.cjs.map
