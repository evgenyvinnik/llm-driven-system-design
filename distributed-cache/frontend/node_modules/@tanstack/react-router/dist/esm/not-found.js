import { jsx } from "react/jsx-runtime";
import { isNotFound } from "@tanstack/router-core";
import { CatchBoundary } from "./CatchBoundary.js";
import { useRouterState } from "./useRouterState.js";
function CatchNotFound(props) {
  const resetKey = useRouterState({
    select: (s) => `not-found-${s.location.pathname}-${s.status}`
  });
  return /* @__PURE__ */ jsx(
    CatchBoundary,
    {
      getResetKey: () => resetKey,
      onCatch: (error, errorInfo) => {
        if (isNotFound(error)) {
          props.onCatch?.(error, errorInfo);
        } else {
          throw error;
        }
      },
      errorComponent: ({ error }) => {
        if (isNotFound(error)) {
          return props.fallback?.(error);
        } else {
          throw error;
        }
      },
      children: props.children
    }
  );
}
function DefaultGlobalNotFound() {
  return /* @__PURE__ */ jsx("p", { children: "Not Found" });
}
export {
  CatchNotFound,
  DefaultGlobalNotFound
};
//# sourceMappingURL=not-found.js.map
