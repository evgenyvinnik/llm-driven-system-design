"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const routerCore = require("@tanstack/router-core");
const useRouter = require("./useRouter.cjs");
function useScrollRestoration() {
  const router = useRouter.useRouter();
  routerCore.setupScrollRestoration(router, true);
}
function ScrollRestoration(_props) {
  useScrollRestoration();
  if (process.env.NODE_ENV === "development") {
    console.warn(
      "The ScrollRestoration component is deprecated. Use createRouter's `scrollRestoration` option instead."
    );
  }
  return null;
}
function useElementScrollRestoration(options) {
  useScrollRestoration();
  const router = useRouter.useRouter();
  const getKey = options.getKey || routerCore.defaultGetScrollRestorationKey;
  let elementSelector = "";
  if (options.id) {
    elementSelector = `[data-scroll-restoration-id="${options.id}"]`;
  } else {
    const element = options.getElement?.();
    if (!element) {
      return;
    }
    elementSelector = element instanceof Window ? "window" : routerCore.getCssSelector(element);
  }
  const restoreKey = getKey(router.latestLocation);
  const byKey = routerCore.scrollRestorationCache?.state[restoreKey];
  return byKey?.[elementSelector];
}
exports.ScrollRestoration = ScrollRestoration;
exports.useElementScrollRestoration = useElementScrollRestoration;
//# sourceMappingURL=ScrollRestoration.cjs.map
