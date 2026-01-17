import invariant from "tiny-invariant";
import { createLRUCache } from "./lru-cache.js";
import { last } from "./utils.js";
const SEGMENT_TYPE_PATHNAME = 0;
const SEGMENT_TYPE_PARAM = 1;
const SEGMENT_TYPE_WILDCARD = 2;
const SEGMENT_TYPE_OPTIONAL_PARAM = 3;
const SEGMENT_TYPE_INDEX = 4;
const SEGMENT_TYPE_PATHLESS = 5;
const PARAM_W_CURLY_BRACES_RE = /^([^{]*)\{\$([a-zA-Z_$][a-zA-Z0-9_$]*)\}([^}]*)$/;
const OPTIONAL_PARAM_W_CURLY_BRACES_RE = /^([^{]*)\{-\$([a-zA-Z_$][a-zA-Z0-9_$]*)\}([^}]*)$/;
const WILDCARD_W_CURLY_BRACES_RE = /^([^{]*)\{\$\}([^}]*)$/;
function parseSegment(path, start, output = new Uint16Array(6)) {
  const next = path.indexOf("/", start);
  const end = next === -1 ? path.length : next;
  const part = path.substring(start, end);
  if (!part || !part.includes("$")) {
    output[0] = SEGMENT_TYPE_PATHNAME;
    output[1] = start;
    output[2] = start;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  if (part === "$") {
    const total = path.length;
    output[0] = SEGMENT_TYPE_WILDCARD;
    output[1] = start;
    output[2] = start;
    output[3] = total;
    output[4] = total;
    output[5] = total;
    return output;
  }
  if (part.charCodeAt(0) === 36) {
    output[0] = SEGMENT_TYPE_PARAM;
    output[1] = start;
    output[2] = start + 1;
    output[3] = end;
    output[4] = end;
    output[5] = end;
    return output;
  }
  const wildcardBracesMatch = part.match(WILDCARD_W_CURLY_BRACES_RE);
  if (wildcardBracesMatch) {
    const prefix = wildcardBracesMatch[1];
    const pLength = prefix.length;
    output[0] = SEGMENT_TYPE_WILDCARD;
    output[1] = start + pLength;
    output[2] = start + pLength + 1;
    output[3] = start + pLength + 2;
    output[4] = start + pLength + 3;
    output[5] = path.length;
    return output;
  }
  const optionalParamBracesMatch = part.match(OPTIONAL_PARAM_W_CURLY_BRACES_RE);
  if (optionalParamBracesMatch) {
    const prefix = optionalParamBracesMatch[1];
    const paramName = optionalParamBracesMatch[2];
    const suffix = optionalParamBracesMatch[3];
    const pLength = prefix.length;
    output[0] = SEGMENT_TYPE_OPTIONAL_PARAM;
    output[1] = start + pLength;
    output[2] = start + pLength + 3;
    output[3] = start + pLength + 3 + paramName.length;
    output[4] = end - suffix.length;
    output[5] = end;
    return output;
  }
  const paramBracesMatch = part.match(PARAM_W_CURLY_BRACES_RE);
  if (paramBracesMatch) {
    const prefix = paramBracesMatch[1];
    const paramName = paramBracesMatch[2];
    const suffix = paramBracesMatch[3];
    const pLength = prefix.length;
    output[0] = SEGMENT_TYPE_PARAM;
    output[1] = start + pLength;
    output[2] = start + pLength + 2;
    output[3] = start + pLength + 2 + paramName.length;
    output[4] = end - suffix.length;
    output[5] = end;
    return output;
  }
  output[0] = SEGMENT_TYPE_PATHNAME;
  output[1] = start;
  output[2] = start;
  output[3] = end;
  output[4] = end;
  output[5] = end;
  return output;
}
function parseSegments(defaultCaseSensitive, data, route, start, node, depth, onRoute) {
  onRoute?.(route);
  let cursor = start;
  {
    const path = route.fullPath ?? route.from;
    const length = path.length;
    const caseSensitive = route.options?.caseSensitive ?? defaultCaseSensitive;
    const skipOnParamError = !!(route.options?.params?.parse && route.options?.skipRouteOnParseError?.params);
    while (cursor < length) {
      const segment = parseSegment(path, cursor, data);
      let nextNode;
      const start2 = cursor;
      const end = segment[5];
      cursor = end + 1;
      depth++;
      const kind = segment[0];
      switch (kind) {
        case SEGMENT_TYPE_PATHNAME: {
          const value = path.substring(segment[2], segment[3]);
          if (caseSensitive) {
            const existingNode = node.static?.get(value);
            if (existingNode) {
              nextNode = existingNode;
            } else {
              node.static ??= /* @__PURE__ */ new Map();
              const next = createStaticNode(
                route.fullPath ?? route.from
              );
              next.parent = node;
              next.depth = depth;
              nextNode = next;
              node.static.set(value, next);
            }
          } else {
            const name = value.toLowerCase();
            const existingNode = node.staticInsensitive?.get(name);
            if (existingNode) {
              nextNode = existingNode;
            } else {
              node.staticInsensitive ??= /* @__PURE__ */ new Map();
              const next = createStaticNode(
                route.fullPath ?? route.from
              );
              next.parent = node;
              next.depth = depth;
              nextNode = next;
              node.staticInsensitive.set(name, next);
            }
          }
          break;
        }
        case SEGMENT_TYPE_PARAM: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw ? void 0 : actuallyCaseSensitive ? prefix_raw : prefix_raw.toLowerCase();
          const suffix = !suffix_raw ? void 0 : actuallyCaseSensitive ? suffix_raw : suffix_raw.toLowerCase();
          const existingNode = !skipOnParamError && node.dynamic?.find(
            (s) => !s.skipOnParamError && s.caseSensitive === actuallyCaseSensitive && s.prefix === prefix && s.suffix === suffix
          );
          if (existingNode) {
            nextNode = existingNode;
          } else {
            const next = createDynamicNode(
              SEGMENT_TYPE_PARAM,
              route.fullPath ?? route.from,
              actuallyCaseSensitive,
              prefix,
              suffix
            );
            nextNode = next;
            next.depth = depth;
            next.parent = node;
            node.dynamic ??= [];
            node.dynamic.push(next);
          }
          break;
        }
        case SEGMENT_TYPE_OPTIONAL_PARAM: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw ? void 0 : actuallyCaseSensitive ? prefix_raw : prefix_raw.toLowerCase();
          const suffix = !suffix_raw ? void 0 : actuallyCaseSensitive ? suffix_raw : suffix_raw.toLowerCase();
          const existingNode = !skipOnParamError && node.optional?.find(
            (s) => !s.skipOnParamError && s.caseSensitive === actuallyCaseSensitive && s.prefix === prefix && s.suffix === suffix
          );
          if (existingNode) {
            nextNode = existingNode;
          } else {
            const next = createDynamicNode(
              SEGMENT_TYPE_OPTIONAL_PARAM,
              route.fullPath ?? route.from,
              actuallyCaseSensitive,
              prefix,
              suffix
            );
            nextNode = next;
            next.parent = node;
            next.depth = depth;
            node.optional ??= [];
            node.optional.push(next);
          }
          break;
        }
        case SEGMENT_TYPE_WILDCARD: {
          const prefix_raw = path.substring(start2, segment[1]);
          const suffix_raw = path.substring(segment[4], end);
          const actuallyCaseSensitive = caseSensitive && !!(prefix_raw || suffix_raw);
          const prefix = !prefix_raw ? void 0 : actuallyCaseSensitive ? prefix_raw : prefix_raw.toLowerCase();
          const suffix = !suffix_raw ? void 0 : actuallyCaseSensitive ? suffix_raw : suffix_raw.toLowerCase();
          const next = createDynamicNode(
            SEGMENT_TYPE_WILDCARD,
            route.fullPath ?? route.from,
            actuallyCaseSensitive,
            prefix,
            suffix
          );
          nextNode = next;
          next.parent = node;
          next.depth = depth;
          node.wildcard ??= [];
          node.wildcard.push(next);
        }
      }
      node = nextNode;
    }
    if (skipOnParamError && route.children && !route.isRoot && route.id && route.id.charCodeAt(route.id.lastIndexOf("/") + 1) === 95) {
      const pathlessNode = createStaticNode(
        route.fullPath ?? route.from
      );
      pathlessNode.kind = SEGMENT_TYPE_PATHLESS;
      pathlessNode.parent = node;
      depth++;
      pathlessNode.depth = depth;
      node.pathless ??= [];
      node.pathless.push(pathlessNode);
      node = pathlessNode;
    }
    const isLeaf = (route.path || !route.children) && !route.isRoot;
    if (isLeaf && path.endsWith("/")) {
      const indexNode = createStaticNode(
        route.fullPath ?? route.from
      );
      indexNode.kind = SEGMENT_TYPE_INDEX;
      indexNode.parent = node;
      depth++;
      indexNode.depth = depth;
      node.index = indexNode;
      node = indexNode;
    }
    node.parse = route.options?.params?.parse ?? null;
    node.skipOnParamError = skipOnParamError;
    node.parsingPriority = route.options?.skipRouteOnParseError?.priority ?? 0;
    if (isLeaf && !node.route) {
      node.route = route;
      node.fullPath = route.fullPath ?? route.from;
    }
  }
  if (route.children)
    for (const child of route.children) {
      parseSegments(
        defaultCaseSensitive,
        data,
        child,
        cursor,
        node,
        depth,
        onRoute
      );
    }
}
function sortDynamic(a, b) {
  if (a.skipOnParamError && !b.skipOnParamError) return -1;
  if (!a.skipOnParamError && b.skipOnParamError) return 1;
  if (a.skipOnParamError && b.skipOnParamError && (a.parsingPriority || b.parsingPriority))
    return b.parsingPriority - a.parsingPriority;
  if (a.prefix && b.prefix && a.prefix !== b.prefix) {
    if (a.prefix.startsWith(b.prefix)) return -1;
    if (b.prefix.startsWith(a.prefix)) return 1;
  }
  if (a.suffix && b.suffix && a.suffix !== b.suffix) {
    if (a.suffix.endsWith(b.suffix)) return -1;
    if (b.suffix.endsWith(a.suffix)) return 1;
  }
  if (a.prefix && !b.prefix) return -1;
  if (!a.prefix && b.prefix) return 1;
  if (a.suffix && !b.suffix) return -1;
  if (!a.suffix && b.suffix) return 1;
  if (a.caseSensitive && !b.caseSensitive) return -1;
  if (!a.caseSensitive && b.caseSensitive) return 1;
  return 0;
}
function sortTreeNodes(node) {
  if (node.pathless) {
    for (const child of node.pathless) {
      sortTreeNodes(child);
    }
  }
  if (node.static) {
    for (const child of node.static.values()) {
      sortTreeNodes(child);
    }
  }
  if (node.staticInsensitive) {
    for (const child of node.staticInsensitive.values()) {
      sortTreeNodes(child);
    }
  }
  if (node.dynamic?.length) {
    node.dynamic.sort(sortDynamic);
    for (const child of node.dynamic) {
      sortTreeNodes(child);
    }
  }
  if (node.optional?.length) {
    node.optional.sort(sortDynamic);
    for (const child of node.optional) {
      sortTreeNodes(child);
    }
  }
  if (node.wildcard?.length) {
    node.wildcard.sort(sortDynamic);
    for (const child of node.wildcard) {
      sortTreeNodes(child);
    }
  }
}
function createStaticNode(fullPath) {
  return {
    kind: SEGMENT_TYPE_PATHNAME,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    skipOnParamError: false,
    parsingPriority: 0
  };
}
function createDynamicNode(kind, fullPath, caseSensitive, prefix, suffix) {
  return {
    kind,
    depth: 0,
    pathless: null,
    index: null,
    static: null,
    staticInsensitive: null,
    dynamic: null,
    optional: null,
    wildcard: null,
    route: null,
    fullPath,
    parent: null,
    parse: null,
    skipOnParamError: false,
    parsingPriority: 0,
    caseSensitive,
    prefix,
    suffix
  };
}
function processRouteMasks(routeList, processedTree) {
  const segmentTree = createStaticNode("/");
  const data = new Uint16Array(6);
  for (const route of routeList) {
    parseSegments(false, data, route, 1, segmentTree, 0);
  }
  sortTreeNodes(segmentTree);
  processedTree.masksTree = segmentTree;
  processedTree.flatCache = createLRUCache(1e3);
}
function findFlatMatch(path, processedTree) {
  path ||= "/";
  const cached = processedTree.flatCache.get(path);
  if (cached) return cached;
  const result = findMatch(path, processedTree.masksTree);
  processedTree.flatCache.set(path, result);
  return result;
}
function findSingleMatch(from, caseSensitive, fuzzy, path, processedTree) {
  from ||= "/";
  path ||= "/";
  const key = caseSensitive ? `case\0${from}` : from;
  let tree = processedTree.singleCache.get(key);
  if (!tree) {
    tree = createStaticNode("/");
    const data = new Uint16Array(6);
    parseSegments(caseSensitive, data, { from }, 1, tree, 0);
    processedTree.singleCache.set(key, tree);
  }
  return findMatch(path, tree, fuzzy);
}
function findRouteMatch(path, processedTree, fuzzy = false) {
  const key = fuzzy ? path : `nofuzz\0${path}`;
  const cached = processedTree.matchCache.get(key);
  if (cached !== void 0) return cached;
  path ||= "/";
  const result = findMatch(
    path,
    processedTree.segmentTree,
    fuzzy
  );
  if (result) result.branch = buildRouteBranch(result.route);
  processedTree.matchCache.set(key, result);
  return result;
}
function trimPathRight(path) {
  return path === "/" ? path : path.replace(/\/{1,}$/, "");
}
function processRouteTree(routeTree, caseSensitive = false, initRoute) {
  const segmentTree = createStaticNode(routeTree.fullPath);
  const data = new Uint16Array(6);
  const routesById = {};
  const routesByPath = {};
  let index = 0;
  parseSegments(caseSensitive, data, routeTree, 1, segmentTree, 0, (route) => {
    initRoute?.(route, index);
    invariant(
      !(route.id in routesById),
      `Duplicate routes found with id: ${String(route.id)}`
    );
    routesById[route.id] = route;
    if (index !== 0 && route.path) {
      const trimmedFullPath = trimPathRight(route.fullPath);
      if (!routesByPath[trimmedFullPath] || route.fullPath.endsWith("/")) {
        routesByPath[trimmedFullPath] = route;
      }
    }
    index++;
  });
  sortTreeNodes(segmentTree);
  const processedTree = {
    segmentTree,
    singleCache: createLRUCache(1e3),
    matchCache: createLRUCache(1e3),
    flatCache: null,
    masksTree: null
  };
  return {
    processedTree,
    routesById,
    routesByPath
  };
}
function findMatch(path, segmentTree, fuzzy = false) {
  const parts = path.split("/");
  const leaf = getNodeMatch(path, parts, segmentTree, fuzzy);
  if (!leaf) return null;
  const [rawParams] = extractParams(path, parts, leaf);
  return {
    route: leaf.node.route,
    rawParams,
    parsedParams: leaf.parsedParams
  };
}
function extractParams(path, parts, leaf) {
  const list = buildBranch(leaf.node);
  let nodeParts = null;
  const rawParams = {};
  let partIndex = leaf.extract?.part ?? 0;
  let nodeIndex = leaf.extract?.node ?? 0;
  let pathIndex = leaf.extract?.path ?? 0;
  for (; nodeIndex < list.length; partIndex++, nodeIndex++, pathIndex++) {
    const node = list[nodeIndex];
    const part = parts[partIndex];
    const currentPathIndex = pathIndex;
    if (part) pathIndex += part.length;
    if (node.kind === SEGMENT_TYPE_PARAM) {
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[nodeIndex];
      const preLength = node.prefix?.length ?? 0;
      const isCurlyBraced = nodePart.charCodeAt(preLength) === 123;
      if (isCurlyBraced) {
        const sufLength = node.suffix?.length ?? 0;
        const name = nodePart.substring(
          preLength + 2,
          nodePart.length - sufLength - 1
        );
        const value = part.substring(preLength, part.length - sufLength);
        rawParams[name] = decodeURIComponent(value);
      } else {
        const name = nodePart.substring(1);
        rawParams[name] = decodeURIComponent(part);
      }
    } else if (node.kind === SEGMENT_TYPE_OPTIONAL_PARAM) {
      if (leaf.skipped & 1 << nodeIndex) {
        partIndex--;
        continue;
      }
      nodeParts ??= leaf.node.fullPath.split("/");
      const nodePart = nodeParts[nodeIndex];
      const preLength = node.prefix?.length ?? 0;
      const sufLength = node.suffix?.length ?? 0;
      const name = nodePart.substring(
        preLength + 3,
        nodePart.length - sufLength - 1
      );
      const value = node.suffix || node.prefix ? part.substring(preLength, part.length - sufLength) : part;
      if (value) rawParams[name] = decodeURIComponent(value);
    } else if (node.kind === SEGMENT_TYPE_WILDCARD) {
      const n = node;
      const value = path.substring(
        currentPathIndex + (n.prefix?.length ?? 0),
        path.length - (n.suffix?.length ?? 0)
      );
      const splat = decodeURIComponent(value);
      rawParams["*"] = splat;
      rawParams._splat = splat;
      break;
    }
  }
  if (leaf.rawParams) Object.assign(rawParams, leaf.rawParams);
  return [rawParams, { part: partIndex, node: nodeIndex, path: pathIndex }];
}
function buildRouteBranch(route) {
  const list = [route];
  while (route.parentRoute) {
    route = route.parentRoute;
    list.push(route);
  }
  list.reverse();
  return list;
}
function buildBranch(node) {
  const list = Array(node.depth + 1);
  do {
    list[node.depth] = node;
    node = node.parent;
  } while (node);
  return list;
}
function getNodeMatch(path, parts, segmentTree, fuzzy) {
  if (path === "/" && segmentTree.index)
    return { node: segmentTree.index, skipped: 0 };
  const trailingSlash = !last(parts);
  const pathIsIndex = trailingSlash && path !== "/";
  const partsLength = parts.length - (trailingSlash ? 1 : 0);
  const stack = [
    {
      node: segmentTree,
      index: 1,
      skipped: 0,
      depth: 1,
      statics: 1,
      dynamics: 0,
      optionals: 0
    }
  ];
  let wildcardMatch = null;
  let bestFuzzy = null;
  let bestMatch = null;
  while (stack.length) {
    const frame = stack.pop();
    const { node, index, skipped, depth, statics, dynamics, optionals } = frame;
    let { extract, rawParams, parsedParams } = frame;
    if (node.skipOnParamError) {
      const result = validateMatchParams(path, parts, frame);
      if (!result) continue;
      rawParams = frame.rawParams;
      extract = frame.extract;
      parsedParams = frame.parsedParams;
    }
    if (fuzzy && node.route && node.kind !== SEGMENT_TYPE_INDEX && isFrameMoreSpecific(bestFuzzy, frame)) {
      bestFuzzy = frame;
    }
    const isBeyondPath = index === partsLength;
    if (isBeyondPath) {
      if (node.route && !pathIsIndex && isFrameMoreSpecific(bestMatch, frame)) {
        bestMatch = frame;
      }
      if (!node.optional && !node.wildcard && !node.index && !node.pathless)
        continue;
    }
    const part = isBeyondPath ? void 0 : parts[index];
    let lowerPart;
    if (isBeyondPath && node.index) {
      const indexFrame = {
        node: node.index,
        index,
        skipped,
        depth: depth + 1,
        statics,
        dynamics,
        optionals,
        extract,
        rawParams,
        parsedParams
      };
      if (node.index.skipOnParamError) {
        const result = validateMatchParams(path, parts, indexFrame);
        if (!result) continue;
      }
      if (statics === partsLength && !dynamics && !optionals && !skipped) {
        return indexFrame;
      }
      if (isFrameMoreSpecific(bestMatch, indexFrame)) {
        bestMatch = indexFrame;
      }
    }
    if (node.wildcard && isFrameMoreSpecific(wildcardMatch, frame)) {
      for (const segment of node.wildcard) {
        const { prefix, suffix } = segment;
        if (prefix) {
          if (isBeyondPath) continue;
          const casePart = segment.caseSensitive ? part : lowerPart ??= part.toLowerCase();
          if (!casePart.startsWith(prefix)) continue;
        }
        if (suffix) {
          if (isBeyondPath) continue;
          const end = parts.slice(index).join("/").slice(-suffix.length);
          const casePart = segment.caseSensitive ? end : end.toLowerCase();
          if (casePart !== suffix) continue;
        }
        const frame2 = {
          node: segment,
          index: partsLength,
          skipped,
          depth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams
        };
        if (segment.skipOnParamError) {
          const result = validateMatchParams(path, parts, frame2);
          if (!result) continue;
        }
        wildcardMatch = frame2;
        break;
      }
    }
    if (node.optional) {
      const nextSkipped = skipped | 1 << depth;
      const nextDepth = depth + 1;
      for (let i = node.optional.length - 1; i >= 0; i--) {
        const segment = node.optional[i];
        stack.push({
          node: segment,
          index,
          skipped: nextSkipped,
          depth: nextDepth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams
        });
      }
      if (!isBeyondPath) {
        for (let i = node.optional.length - 1; i >= 0; i--) {
          const segment = node.optional[i];
          const { prefix, suffix } = segment;
          if (prefix || suffix) {
            const casePart = segment.caseSensitive ? part : lowerPart ??= part.toLowerCase();
            if (prefix && !casePart.startsWith(prefix)) continue;
            if (suffix && !casePart.endsWith(suffix)) continue;
          }
          stack.push({
            node: segment,
            index: index + 1,
            skipped,
            depth: nextDepth,
            statics,
            dynamics,
            optionals: optionals + 1,
            extract,
            rawParams,
            parsedParams
          });
        }
      }
    }
    if (!isBeyondPath && node.dynamic && part) {
      for (let i = node.dynamic.length - 1; i >= 0; i--) {
        const segment = node.dynamic[i];
        const { prefix, suffix } = segment;
        if (prefix || suffix) {
          const casePart = segment.caseSensitive ? part : lowerPart ??= part.toLowerCase();
          if (prefix && !casePart.startsWith(prefix)) continue;
          if (suffix && !casePart.endsWith(suffix)) continue;
        }
        stack.push({
          node: segment,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics,
          dynamics: dynamics + 1,
          optionals,
          extract,
          rawParams,
          parsedParams
        });
      }
    }
    if (!isBeyondPath && node.staticInsensitive) {
      const match = node.staticInsensitive.get(
        lowerPart ??= part.toLowerCase()
      );
      if (match) {
        stack.push({
          node: match,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics: statics + 1,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams
        });
      }
    }
    if (!isBeyondPath && node.static) {
      const match = node.static.get(part);
      if (match) {
        stack.push({
          node: match,
          index: index + 1,
          skipped,
          depth: depth + 1,
          statics: statics + 1,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams
        });
      }
    }
    if (node.pathless) {
      const nextDepth = depth + 1;
      for (let i = node.pathless.length - 1; i >= 0; i--) {
        const segment = node.pathless[i];
        stack.push({
          node: segment,
          index,
          skipped,
          depth: nextDepth,
          statics,
          dynamics,
          optionals,
          extract,
          rawParams,
          parsedParams
        });
      }
    }
  }
  if (bestMatch && wildcardMatch) {
    return isFrameMoreSpecific(wildcardMatch, bestMatch) ? bestMatch : wildcardMatch;
  }
  if (bestMatch) return bestMatch;
  if (wildcardMatch) return wildcardMatch;
  if (fuzzy && bestFuzzy) {
    let sliceIndex = bestFuzzy.index;
    for (let i = 0; i < bestFuzzy.index; i++) {
      sliceIndex += parts[i].length;
    }
    const splat = sliceIndex === path.length ? "/" : path.slice(sliceIndex);
    bestFuzzy.rawParams ??= {};
    bestFuzzy.rawParams["**"] = decodeURIComponent(splat);
    return bestFuzzy;
  }
  return null;
}
function validateMatchParams(path, parts, frame) {
  try {
    const [rawParams, state] = extractParams(path, parts, frame);
    frame.rawParams = rawParams;
    frame.extract = state;
    const parsed = frame.node.parse(rawParams);
    frame.parsedParams = Object.assign({}, frame.parsedParams, parsed);
    return true;
  } catch {
    return null;
  }
}
function isFrameMoreSpecific(prev, next) {
  if (!prev) return true;
  return next.statics > prev.statics || next.statics === prev.statics && (next.dynamics > prev.dynamics || next.dynamics === prev.dynamics && (next.optionals > prev.optionals || next.optionals === prev.optionals && ((next.node.kind === SEGMENT_TYPE_INDEX) > (prev.node.kind === SEGMENT_TYPE_INDEX) || next.node.kind === SEGMENT_TYPE_INDEX === (prev.node.kind === SEGMENT_TYPE_INDEX) && next.depth > prev.depth)));
}
export {
  SEGMENT_TYPE_OPTIONAL_PARAM,
  SEGMENT_TYPE_PARAM,
  SEGMENT_TYPE_PATHNAME,
  SEGMENT_TYPE_WILDCARD,
  findFlatMatch,
  findRouteMatch,
  findSingleMatch,
  parseSegment,
  processRouteMasks,
  processRouteTree,
  trimPathRight
};
//# sourceMappingURL=new-process-route-tree.js.map
