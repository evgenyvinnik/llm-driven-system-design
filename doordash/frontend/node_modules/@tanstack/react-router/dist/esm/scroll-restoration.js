import { jsx } from "react/jsx-runtime";
import { defaultGetScrollRestorationKey, restoreScroll, escapeHtml, storageKey } from "@tanstack/router-core";
import { useRouter } from "./useRouter.js";
import { ScriptOnce } from "./ScriptOnce.js";
function ScrollRestoration() {
  const router = useRouter();
  if (!router.isScrollRestoring || !router.isServer) {
    return null;
  }
  if (typeof router.options.scrollRestoration === "function") {
    const shouldRestore = router.options.scrollRestoration({
      location: router.latestLocation
    });
    if (!shouldRestore) {
      return null;
    }
  }
  const getKey = router.options.getScrollRestorationKey || defaultGetScrollRestorationKey;
  const userKey = getKey(router.latestLocation);
  const resolvedKey = userKey !== defaultGetScrollRestorationKey(router.latestLocation) ? userKey : void 0;
  const restoreScrollOptions = {
    storageKey,
    shouldScrollRestoration: true
  };
  if (resolvedKey) {
    restoreScrollOptions.key = resolvedKey;
  }
  return /* @__PURE__ */ jsx(
    ScriptOnce,
    {
      children: `(${restoreScroll.toString()})(${escapeHtml(JSON.stringify(restoreScrollOptions))})`
    }
  );
}
export {
  ScrollRestoration
};
//# sourceMappingURL=scroll-restoration.js.map
