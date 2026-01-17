import { jsxs, jsx } from "react/jsx-runtime";
import * as React from "react";
import warning from "tiny-warning";
import { rootRouteId } from "@tanstack/router-core";
import { CatchBoundary, ErrorComponent } from "./CatchBoundary.js";
import { useRouterState } from "./useRouterState.js";
import { useRouter } from "./useRouter.js";
import { Transitioner } from "./Transitioner.js";
import { matchContext } from "./matchContext.js";
import { Match } from "./Match.js";
import { SafeFragment } from "./SafeFragment.js";
function Matches() {
  const router = useRouter();
  const rootRoute = router.routesById[rootRouteId];
  const PendingComponent = rootRoute.options.pendingComponent ?? router.options.defaultPendingComponent;
  const pendingElement = PendingComponent ? /* @__PURE__ */ jsx(PendingComponent, {}) : null;
  const ResolvedSuspense = router.isServer || typeof document !== "undefined" && router.ssr ? SafeFragment : React.Suspense;
  const inner = /* @__PURE__ */ jsxs(ResolvedSuspense, { fallback: pendingElement, children: [
    !router.isServer && /* @__PURE__ */ jsx(Transitioner, {}),
    /* @__PURE__ */ jsx(MatchesInner, {})
  ] });
  return router.options.InnerWrap ? /* @__PURE__ */ jsx(router.options.InnerWrap, { children: inner }) : inner;
}
function MatchesInner() {
  const router = useRouter();
  const matchId = useRouterState({
    select: (s) => {
      return s.matches[0]?.id;
    }
  });
  const resetKey = useRouterState({
    select: (s) => s.loadedAt
  });
  const matchComponent = matchId ? /* @__PURE__ */ jsx(Match, { matchId }) : null;
  return /* @__PURE__ */ jsx(matchContext.Provider, { value: matchId, children: router.options.disableGlobalCatchBoundary ? matchComponent : /* @__PURE__ */ jsx(
    CatchBoundary,
    {
      getResetKey: () => resetKey,
      errorComponent: ErrorComponent,
      onCatch: (error) => {
        warning(
          false,
          `The following error wasn't caught by any route! At the very least, consider setting an 'errorComponent' in your RootRoute!`
        );
        warning(false, error.message || error.toString());
      },
      children: matchComponent
    }
  ) });
}
function useMatchRoute() {
  const router = useRouter();
  useRouterState({
    select: (s) => [s.location.href, s.resolvedLocation?.href, s.status],
    structuralSharing: true
  });
  return React.useCallback(
    (opts) => {
      const { pending, caseSensitive, fuzzy, includeSearch, ...rest } = opts;
      return router.matchRoute(rest, {
        pending,
        caseSensitive,
        fuzzy,
        includeSearch
      });
    },
    [router]
  );
}
function MatchRoute(props) {
  const matchRoute = useMatchRoute();
  const params = matchRoute(props);
  if (typeof props.children === "function") {
    return props.children(params);
  }
  return params ? props.children : null;
}
function useMatches(opts) {
  return useRouterState({
    select: (state) => {
      const matches = state.matches;
      return opts?.select ? opts.select(matches) : matches;
    },
    structuralSharing: opts?.structuralSharing
  });
}
function useParentMatches(opts) {
  const contextMatchId = React.useContext(matchContext);
  return useMatches({
    select: (matches) => {
      matches = matches.slice(
        0,
        matches.findIndex((d) => d.id === contextMatchId)
      );
      return opts?.select ? opts.select(matches) : matches;
    },
    structuralSharing: opts?.structuralSharing
  });
}
function useChildMatches(opts) {
  const contextMatchId = React.useContext(matchContext);
  return useMatches({
    select: (matches) => {
      matches = matches.slice(
        matches.findIndex((d) => d.id === contextMatchId) + 1
      );
      return opts?.select ? opts.select(matches) : matches;
    },
    structuralSharing: opts?.structuralSharing
  });
}
export {
  MatchRoute,
  Matches,
  useChildMatches,
  useMatchRoute,
  useMatches,
  useParentMatches
};
//# sourceMappingURL=Matches.js.map
