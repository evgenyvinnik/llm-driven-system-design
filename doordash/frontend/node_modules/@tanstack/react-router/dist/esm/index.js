import { PathParamError, SearchParamError, TSR_DEFERRED_PROMISE, cleanPath, componentTypes, composeRewrites, createControlledPromise, createRouterConfig, createSerializationAdapter, deepEqual, defaultParseSearch, defaultSerializeError, defaultStringifySearch, defer, functionalUpdate, getInitialRouterState, interpolatePath, isMatch, isNotFound, isPlainArray, isPlainObject, isRedirect, joinPaths, lazyFn, notFound, parseSearchWith, redirect, replaceEqualDeep, resolvePath, retainSearchParams, rootRouteId, stringifySearchWith, stripSearchParams, trimPath, trimPathLeft, trimPathRight } from "@tanstack/router-core";
import { createBrowserHistory, createHashHistory, createHistory, createMemoryHistory } from "@tanstack/history";
import { Await, useAwaited } from "./awaited.js";
import { CatchBoundary, ErrorComponent } from "./CatchBoundary.js";
import { ClientOnly, useHydrated } from "./ClientOnly.js";
import { FileRoute, FileRouteLoader, LazyRoute, createFileRoute, createLazyFileRoute, createLazyRoute } from "./fileRoute.js";
import { lazyRouteComponent } from "./lazyRouteComponent.js";
import { Link, createLink, linkOptions, useLinkProps } from "./link.js";
import { MatchRoute, Matches, useChildMatches, useMatchRoute, useMatches, useParentMatches } from "./Matches.js";
import { matchContext } from "./matchContext.js";
import { Match, Outlet } from "./Match.js";
import { useMatch } from "./useMatch.js";
import { useLoaderDeps } from "./useLoaderDeps.js";
import { useLoaderData } from "./useLoaderData.js";
import { NotFoundRoute, RootRoute, Route, RouteApi, createRootRoute, createRootRouteWithContext, createRoute, createRouteMask, getRouteApi, rootRouteWithContext } from "./route.js";
import { Router, createRouter } from "./router.js";
import { RouterContextProvider, RouterProvider } from "./RouterProvider.js";
import { ScrollRestoration, useElementScrollRestoration } from "./ScrollRestoration.js";
import { Block, useBlocker } from "./useBlocker.js";
import { Navigate, useNavigate } from "./useNavigate.js";
import { useParams } from "./useParams.js";
import { useSearch } from "./useSearch.js";
import { getRouterContext } from "./routerContext.js";
import { useRouteContext } from "./useRouteContext.js";
import { useRouter } from "./useRouter.js";
import { useRouterState } from "./useRouterState.js";
import { useLocation } from "./useLocation.js";
import { useCanGoBack } from "./useCanGoBack.js";
import { useLayoutEffect, useStableCallback } from "./utils.js";
import { CatchNotFound, DefaultGlobalNotFound } from "./not-found.js";
import { ScriptOnce } from "./ScriptOnce.js";
import { Asset } from "./Asset.js";
import { HeadContent } from "./HeadContent.js";
import { useTags } from "./headContentUtils.js";
import { Scripts } from "./Scripts.js";
export {
  Asset,
  Await,
  Block,
  CatchBoundary,
  CatchNotFound,
  ClientOnly,
  DefaultGlobalNotFound,
  ErrorComponent,
  FileRoute,
  FileRouteLoader,
  HeadContent,
  LazyRoute,
  Link,
  Match,
  MatchRoute,
  Matches,
  Navigate,
  NotFoundRoute,
  Outlet,
  PathParamError,
  RootRoute,
  Route,
  RouteApi,
  Router,
  RouterContextProvider,
  RouterProvider,
  ScriptOnce,
  Scripts,
  ScrollRestoration,
  SearchParamError,
  TSR_DEFERRED_PROMISE,
  cleanPath,
  componentTypes,
  composeRewrites,
  createBrowserHistory,
  createControlledPromise,
  createFileRoute,
  createHashHistory,
  createHistory,
  createLazyFileRoute,
  createLazyRoute,
  createLink,
  createMemoryHistory,
  createRootRoute,
  createRootRouteWithContext,
  createRoute,
  createRouteMask,
  createRouter,
  createRouterConfig,
  createSerializationAdapter,
  deepEqual,
  defaultParseSearch,
  defaultSerializeError,
  defaultStringifySearch,
  defer,
  functionalUpdate,
  getInitialRouterState,
  getRouteApi,
  getRouterContext,
  interpolatePath,
  isMatch,
  isNotFound,
  isPlainArray,
  isPlainObject,
  isRedirect,
  joinPaths,
  lazyFn,
  lazyRouteComponent,
  linkOptions,
  matchContext,
  notFound,
  parseSearchWith,
  redirect,
  replaceEqualDeep,
  resolvePath,
  retainSearchParams,
  rootRouteId,
  rootRouteWithContext,
  stringifySearchWith,
  stripSearchParams,
  trimPath,
  trimPathLeft,
  trimPathRight,
  useAwaited,
  useBlocker,
  useCanGoBack,
  useChildMatches,
  useElementScrollRestoration,
  useHydrated,
  useLayoutEffect,
  useLinkProps,
  useLoaderData,
  useLoaderDeps,
  useLocation,
  useMatch,
  useMatchRoute,
  useMatches,
  useNavigate,
  useParams,
  useParentMatches,
  useRouteContext,
  useRouter,
  useRouterState,
  useSearch,
  useStableCallback,
  useTags
};
//# sourceMappingURL=index.js.map
