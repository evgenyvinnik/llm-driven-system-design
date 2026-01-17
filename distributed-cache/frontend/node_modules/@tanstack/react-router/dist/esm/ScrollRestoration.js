import { defaultGetScrollRestorationKey, getCssSelector, scrollRestorationCache, setupScrollRestoration } from "@tanstack/router-core";
import { useRouter } from "./useRouter.js";
function useScrollRestoration() {
  const router = useRouter();
  setupScrollRestoration(router, true);
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
  const router = useRouter();
  const getKey = options.getKey || defaultGetScrollRestorationKey;
  let elementSelector = "";
  if (options.id) {
    elementSelector = `[data-scroll-restoration-id="${options.id}"]`;
  } else {
    const element = options.getElement?.();
    if (!element) {
      return;
    }
    elementSelector = element instanceof Window ? "window" : getCssSelector(element);
  }
  const restoreKey = getKey(router.latestLocation);
  const byKey = scrollRestorationCache?.state[restoreKey];
  return byKey?.[elementSelector];
}
export {
  ScrollRestoration,
  useElementScrollRestoration
};
//# sourceMappingURL=ScrollRestoration.js.map
