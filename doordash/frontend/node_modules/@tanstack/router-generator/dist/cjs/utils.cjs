"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const fsp = require("node:fs/promises");
const path = require("node:path");
const prettier = require("prettier");
const rootPathId = require("./filesystem/physical/rootPathId.cjs");
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
const fsp__namespace = /* @__PURE__ */ _interopNamespaceDefault(fsp);
const prettier__namespace = /* @__PURE__ */ _interopNamespaceDefault(prettier);
class RoutePrefixMap {
  constructor(routes) {
    this.prefixToRoute = /* @__PURE__ */ new Map();
    this.layoutRoutes = [];
    for (const route of routes) {
      if (!route.routePath || route.routePath === `/${rootPathId.rootPathId}`) continue;
      if (route._fsRouteType === "lazy" || route._fsRouteType === "loader" || route._fsRouteType === "component" || route._fsRouteType === "pendingComponent" || route._fsRouteType === "errorComponent" || route._fsRouteType === "notFoundComponent") {
        continue;
      }
      this.prefixToRoute.set(route.routePath, route);
      if (route._fsRouteType === "pathless_layout" || route._fsRouteType === "layout" || route._fsRouteType === "__root") {
        this.layoutRoutes.push(route);
      }
    }
    this.layoutRoutes.sort(
      (a, b) => (b.routePath?.length ?? 0) - (a.routePath?.length ?? 0)
    );
  }
  /**
   * Find the longest matching parent route for a given path.
   * O(k) where k is the number of path segments, not O(n) routes.
   */
  findParent(routePath) {
    if (!routePath || routePath === "/") return null;
    let searchPath = routePath;
    while (searchPath.length > 0) {
      const lastSlash = searchPath.lastIndexOf("/");
      if (lastSlash <= 0) break;
      searchPath = searchPath.substring(0, lastSlash);
      const parent = this.prefixToRoute.get(searchPath);
      if (parent && parent.routePath !== routePath) {
        return parent;
      }
    }
    return null;
  }
  /**
   * Check if a route exists at the given path.
   */
  has(routePath) {
    return this.prefixToRoute.has(routePath);
  }
  /**
   * Get a route by exact path.
   */
  get(routePath) {
    return this.prefixToRoute.get(routePath);
  }
}
function multiSortBy(arr, accessors = [(d) => d]) {
  const len = arr.length;
  const indexed = new Array(len);
  for (let i = 0; i < len; i++) {
    const item = arr[i];
    const keys = new Array(accessors.length);
    for (let j = 0; j < accessors.length; j++) {
      keys[j] = accessors[j](item);
    }
    indexed[i] = { item, index: i, keys };
  }
  indexed.sort((a, b) => {
    for (let j = 0; j < accessors.length; j++) {
      const ao = a.keys[j];
      const bo = b.keys[j];
      if (typeof ao === "undefined") {
        if (typeof bo === "undefined") {
          continue;
        }
        return 1;
      }
      if (ao === bo) {
        continue;
      }
      return ao > bo ? 1 : -1;
    }
    return a.index - b.index;
  });
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = indexed[i].item;
  }
  return result;
}
function cleanPath(path2) {
  return path2.replace(/\/{2,}/g, "/");
}
function trimPathLeft(path2) {
  return path2 === "/" ? path2 : path2.replace(/^\/{1,}/, "");
}
function removeLeadingSlash(path2) {
  return path2.replace(/^\//, "");
}
function removeTrailingSlash(s) {
  return s.replace(/\/$/, "");
}
const BRACKET_CONTENT_RE = /\[(.*?)\]/g;
const SPLIT_REGEX = new RegExp("(?<!\\[)\\.(?!\\])", "g");
const DISALLOWED_ESCAPE_CHARS = /* @__PURE__ */ new Set([
  "/",
  "\\",
  "?",
  "#",
  ":",
  "*",
  "<",
  ">",
  "|",
  "!",
  "$",
  "%"
]);
function determineInitialRoutePath(routePath) {
  const originalRoutePath = cleanPath(
    `/${(cleanPath(routePath) || "").split(SPLIT_REGEX).join("/")}`
  ) || "";
  const parts = routePath.split(SPLIT_REGEX);
  const escapedParts = parts.map((part) => {
    let match;
    while ((match = BRACKET_CONTENT_RE.exec(part)) !== null) {
      const character = match[1];
      if (character === void 0) continue;
      if (DISALLOWED_ESCAPE_CHARS.has(character)) {
        console.error(
          `Error: Disallowed character "${character}" found in square brackets in route path "${routePath}".
You cannot use any of the following characters in square brackets: ${Array.from(
            DISALLOWED_ESCAPE_CHARS
          ).join(", ")}
Please remove and/or replace them.`
        );
        process.exit(1);
      }
    }
    return part.replace(BRACKET_CONTENT_RE, "$1");
  });
  const final = cleanPath(`/${escapedParts.join("/")}`) || "";
  return {
    routePath: final,
    originalRoutePath
  };
}
function isFullyEscapedSegment(originalSegment) {
  return originalSegment.startsWith("[") && originalSegment.endsWith("]") && !originalSegment.slice(1, -1).includes("[") && !originalSegment.slice(1, -1).includes("]");
}
function hasEscapedLeadingUnderscore(originalSegment) {
  return originalSegment.startsWith("[_]") || originalSegment.startsWith("[_") && isFullyEscapedSegment(originalSegment);
}
function hasEscapedTrailingUnderscore(originalSegment) {
  return originalSegment.endsWith("[_]") || originalSegment.endsWith("_]") && isFullyEscapedSegment(originalSegment);
}
const backslashRegex = /\\/g;
function replaceBackslash(s) {
  return s.replace(backslashRegex, "/");
}
const alphanumericRegex = /[a-zA-Z0-9_]/;
const splatSlashRegex = /\/\$\//g;
const trailingSplatRegex = /\$$/g;
const bracketSplatRegex = /\$\{\$\}/g;
const dollarSignRegex = /\$/g;
const splitPathRegex = /[/-]/g;
const leadingDigitRegex = /^(\d)/g;
const toVariableSafeChar = (char) => {
  if (alphanumericRegex.test(char)) {
    return char;
  }
  switch (char) {
    case ".":
      return "Dot";
    case "-":
      return "Dash";
    case "@":
      return "At";
    case "(":
      return "";
    // Removed since route groups use parentheses
    case ")":
      return "";
    // Removed since route groups use parentheses
    case " ":
      return "";
    // Remove spaces
    default:
      return `Char${char.charCodeAt(0)}`;
  }
};
function routePathToVariable(routePath) {
  const cleaned = removeUnderscores(routePath);
  if (!cleaned) return "";
  const parts = cleaned.replace(splatSlashRegex, "/splat/").replace(trailingSplatRegex, "splat").replace(bracketSplatRegex, "splat").replace(dollarSignRegex, "").split(splitPathRegex);
  let result = "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const segment = i > 0 ? capitalize(part) : part;
    for (let j = 0; j < segment.length; j++) {
      result += toVariableSafeChar(segment[j]);
    }
  }
  return result.replace(leadingDigitRegex, "R$1");
}
const underscoreStartEndRegex = /(^_|_$)/gi;
const underscoreSlashRegex = /(\/_|_\/)/gi;
function removeUnderscores(s) {
  return s?.replace(underscoreStartEndRegex, "").replace(underscoreSlashRegex, "/");
}
function removeUnderscoresWithEscape(routePath, originalPath) {
  if (!routePath) return "";
  if (!originalPath) return removeUnderscores(routePath) ?? "";
  const routeSegments = routePath.split("/");
  const originalSegments = originalPath.split("/");
  const newSegments = routeSegments.map((segment, i) => {
    const originalSegment = originalSegments[i] || "";
    const leadingEscaped = hasEscapedLeadingUnderscore(originalSegment);
    const trailingEscaped = hasEscapedTrailingUnderscore(originalSegment);
    let result = segment;
    if (result.startsWith("_") && !leadingEscaped) {
      result = result.slice(1);
    }
    if (result.endsWith("_") && !trailingEscaped) {
      result = result.slice(0, -1);
    }
    return result;
  });
  return newSegments.join("/");
}
function removeLayoutSegmentsWithEscape(routePath = "/", originalPath) {
  if (!originalPath) return removeLayoutSegments(routePath);
  const routeSegments = routePath.split("/");
  const originalSegments = originalPath.split("/");
  const newSegments = routeSegments.filter((segment, i) => {
    const originalSegment = originalSegments[i] || "";
    return !isSegmentPathless(segment, originalSegment);
  });
  return newSegments.join("/");
}
function isSegmentPathless(segment, originalSegment) {
  if (!segment.startsWith("_")) return false;
  return !hasEscapedLeadingUnderscore(originalSegment);
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sanitizeTokenFlags(flags) {
  if (!flags) return flags;
  return flags.replace(/[gy]/g, "");
}
function createTokenRegex(token, opts) {
  if (token === void 0 || token === null) {
    throw new Error(
      `createTokenRegex: token is ${token}. This usually means the config was not properly parsed with defaults.`
    );
  }
  try {
    if (typeof token === "string") {
      return opts.type === "segment" ? new RegExp(`^${escapeRegExp(token)}$`) : new RegExp(`[./]${escapeRegExp(token)}[.]`);
    }
    if (token instanceof RegExp) {
      const flags = sanitizeTokenFlags(token.flags);
      return opts.type === "segment" ? new RegExp(`^(?:${token.source})$`, flags) : new RegExp(`[./](?:${token.source})[.]`, flags);
    }
    if (typeof token === "object" && "regex" in token) {
      const flags = sanitizeTokenFlags(token.flags);
      return opts.type === "segment" ? new RegExp(`^(?:${token.regex})$`, flags) : new RegExp(`[./](?:${token.regex})[.]`, flags);
    }
    throw new Error(
      `createTokenRegex: invalid token type. Expected string, RegExp, or { regex, flags } object, got: ${typeof token}`
    );
  } catch (e) {
    if (e instanceof SyntaxError) {
      const pattern = typeof token === "string" ? token : token instanceof RegExp ? token.source : token.regex;
      throw new Error(
        `Invalid regex pattern in token config: "${pattern}". ${e.message}`
      );
    }
    throw e;
  }
}
function isBracketWrappedSegment(segment) {
  return segment.startsWith("[") && segment.endsWith("]");
}
function unwrapBracketWrappedSegment(segment) {
  return isBracketWrappedSegment(segment) ? segment.slice(1, -1) : segment;
}
function capitalize(s) {
  if (typeof s !== "string") return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function removeExt(d, keepExtension = false) {
  return keepExtension ? d : d.substring(0, d.lastIndexOf(".")) || d;
}
async function writeIfDifferent(filepath, content, incomingContent, callbacks) {
  if (content !== incomingContent) {
    callbacks?.beforeWrite?.();
    await fsp__namespace.writeFile(filepath, incomingContent);
    callbacks?.afterWrite?.();
    return true;
  }
  return false;
}
async function format(source, config) {
  const prettierOptions = {
    semi: config.semicolons,
    singleQuote: config.quoteStyle === "single",
    parser: "typescript"
  };
  return prettier__namespace.format(source, prettierOptions);
}
function resetRegex(regex) {
  regex.lastIndex = 0;
  return;
}
async function checkFileExists(file) {
  try {
    await fsp__namespace.access(file, fsp__namespace.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
const possiblyNestedRouteGroupPatternRegex = /\([^/]+\)\/?/g;
function removeGroups(s) {
  return s.replace(possiblyNestedRouteGroupPatternRegex, "");
}
function removeLayoutSegments(routePath = "/") {
  const segments = routePath.split("/");
  const newSegments = segments.filter((segment) => !segment.startsWith("_"));
  return newSegments.join("/");
}
function determineNodePath(node) {
  return node.path = node.parent ? node.routePath?.replace(node.parent.routePath ?? "", "") || "/" : node.routePath;
}
function removeLastSegmentFromPath(routePath = "/") {
  const segments = routePath.split("/");
  segments.pop();
  return segments.join("/");
}
function hasParentRoute(prefixMap, node, routePathToCheck) {
  if (!routePathToCheck || routePathToCheck === "/") {
    return null;
  }
  return prefixMap.findParent(routePathToCheck);
}
const getResolvedRouteNodeVariableName = (routeNode) => {
  return routeNode.children?.length ? `${routeNode.variableName}RouteWithChildren` : `${routeNode.variableName}Route`;
};
function isRouteNodeValidForAugmentation(routeNode) {
  if (!routeNode || routeNode.isVirtual) {
    return false;
  }
  return true;
}
const inferPath = (routeNode) => {
  return routeNode.cleanedPath === "/" ? routeNode.cleanedPath : routeNode.cleanedPath?.replace(/\/$/, "") ?? "";
};
const inferFullPath = (routeNode) => {
  const fullPath = removeGroups(
    removeUnderscoresWithEscape(
      removeLayoutSegmentsWithEscape(
        routeNode.routePath,
        routeNode.originalRoutePath
      ),
      routeNode.originalRoutePath
    )
  );
  return routeNode.cleanedPath === "/" ? fullPath : fullPath.replace(/\/$/, "");
};
const createRouteNodesByFullPath = (routeNodes) => {
  return new Map(
    routeNodes.map((routeNode) => [inferFullPath(routeNode), routeNode])
  );
};
const createRouteNodesByTo = (routeNodes) => {
  return new Map(
    dedupeBranchesAndIndexRoutes(routeNodes).map((routeNode) => [
      inferTo(routeNode),
      routeNode
    ])
  );
};
const createRouteNodesById = (routeNodes) => {
  return new Map(
    routeNodes.map((routeNode) => {
      const id = routeNode.routePath ?? "";
      return [id, routeNode];
    })
  );
};
const inferTo = (routeNode) => {
  const fullPath = inferFullPath(routeNode);
  if (fullPath === "/") return fullPath;
  return fullPath.replace(/\/$/, "");
};
const dedupeBranchesAndIndexRoutes = (routes) => {
  return routes.filter((route) => {
    if (route.children?.find((child) => child.cleanedPath === "/")) return false;
    return true;
  });
};
function checkUnique(routes, key) {
  const keys = routes.map((d) => d[key]);
  const uniqueKeys = new Set(keys);
  if (keys.length !== uniqueKeys.size) {
    const duplicateKeys = keys.filter((d, i) => keys.indexOf(d) !== i);
    const conflictingFiles = routes.filter(
      (d) => duplicateKeys.includes(d[key])
    );
    return conflictingFiles;
  }
  return void 0;
}
function checkRouteFullPathUniqueness(_routes, config) {
  const routes = _routes.map((d) => {
    const inferredFullPath = inferFullPath(d);
    return { ...d, inferredFullPath };
  });
  const conflictingFiles = checkUnique(routes, "inferredFullPath");
  if (conflictingFiles !== void 0) {
    const errorMessage = `Conflicting configuration paths were found for the following route${conflictingFiles.length > 1 ? "s" : ""}: ${conflictingFiles.map((p) => `"${p.inferredFullPath}"`).join(", ")}.
Please ensure each Route has a unique full path.
Conflicting files: 
 ${conflictingFiles.map((d) => path.resolve(config.routesDirectory, d.filePath)).join("\n ")}
`;
    throw new Error(errorMessage);
  }
}
function buildRouteTreeConfig(nodes, disableTypes, depth = 1) {
  const children = nodes.map((node) => {
    if (node._fsRouteType === "__root") {
      return;
    }
    if (node._fsRouteType === "pathless_layout" && !node.children?.length) {
      return;
    }
    const route = `${node.variableName}`;
    if (node.children?.length) {
      const childConfigs = buildRouteTreeConfig(
        node.children,
        disableTypes,
        depth + 1
      );
      const childrenDeclaration = disableTypes ? "" : `interface ${route}RouteChildren {
  ${node.children.map(
        (child) => `${child.variableName}Route: typeof ${getResolvedRouteNodeVariableName(child)}`
      ).join(",")}
}`;
      const children2 = `const ${route}RouteChildren${disableTypes ? "" : `: ${route}RouteChildren`} = {
  ${node.children.map(
        (child) => `${child.variableName}Route: ${getResolvedRouteNodeVariableName(child)}`
      ).join(",")}
}`;
      const routeWithChildren = `const ${route}RouteWithChildren = ${route}Route._addFileChildren(${route}RouteChildren)`;
      return [
        childConfigs.join("\n"),
        childrenDeclaration,
        children2,
        routeWithChildren
      ].join("\n\n");
    }
    return void 0;
  });
  return children.filter((x) => x !== void 0);
}
function buildImportString(importDeclaration) {
  const { source, specifiers, importKind } = importDeclaration;
  return specifiers.length ? `import ${importKind === "type" ? "type " : ""}{ ${specifiers.map((s) => s.local ? `${s.imported} as ${s.local}` : s.imported).join(", ")} } from '${source}'` : "";
}
function mergeImportDeclarations(imports) {
  const merged = /* @__PURE__ */ new Map();
  for (const imp of imports) {
    const key = `${imp.source}-${imp.importKind ?? ""}`;
    let existing = merged.get(key);
    if (!existing) {
      existing = { ...imp, specifiers: [] };
      merged.set(key, existing);
    }
    const existingSpecs = existing.specifiers;
    for (const specifier of imp.specifiers) {
      let found = false;
      for (let i = 0; i < existingSpecs.length; i++) {
        const e = existingSpecs[i];
        if (e.imported === specifier.imported && e.local === specifier.local) {
          found = true;
          break;
        }
      }
      if (!found) {
        existingSpecs.push(specifier);
      }
    }
  }
  return [...merged.values()];
}
const findParent = (node) => {
  if (!node) {
    return `rootRouteImport`;
  }
  if (node.parent) {
    return `${node.parent.variableName}Route`;
  }
  return findParent(node.parent);
};
function buildFileRoutesByPathInterface(opts) {
  return `declare module '${opts.module}' {
  interface ${opts.interfaceName} {
    ${opts.routeNodes.map((routeNode) => {
    const filePathId = routeNode.routePath;
    const preloaderRoute = `typeof ${routeNode.variableName}RouteImport`;
    const parent = findParent(routeNode);
    return `'${filePathId}': {
          id: '${filePathId}'
          path: '${inferPath(routeNode)}'
          fullPath: '${inferFullPath(routeNode)}'
          preLoaderRoute: ${preloaderRoute}
          parentRoute: typeof ${parent}
        }`;
  }).join("\n")}
  }
}`;
}
function getImportPath(node, config, generatedRouteTreePath) {
  return replaceBackslash(
    removeExt(
      path.relative(
        path.dirname(generatedRouteTreePath),
        path.resolve(config.routesDirectory, node.filePath)
      ),
      config.addExtensions
    )
  );
}
function getImportForRouteNode(node, config, generatedRouteTreePath, root) {
  let source = "";
  if (config.importRoutesUsingAbsolutePaths) {
    source = replaceBackslash(
      removeExt(
        path.resolve(root, config.routesDirectory, node.filePath),
        config.addExtensions
      )
    );
  } else {
    source = `./${getImportPath(node, config, generatedRouteTreePath)}`;
  }
  return {
    source,
    specifiers: [
      {
        imported: "Route",
        local: `${node.variableName}RouteImport`
      }
    ]
  };
}
exports.RoutePrefixMap = RoutePrefixMap;
exports.buildFileRoutesByPathInterface = buildFileRoutesByPathInterface;
exports.buildImportString = buildImportString;
exports.buildRouteTreeConfig = buildRouteTreeConfig;
exports.capitalize = capitalize;
exports.checkFileExists = checkFileExists;
exports.checkRouteFullPathUniqueness = checkRouteFullPathUniqueness;
exports.cleanPath = cleanPath;
exports.createRouteNodesByFullPath = createRouteNodesByFullPath;
exports.createRouteNodesById = createRouteNodesById;
exports.createRouteNodesByTo = createRouteNodesByTo;
exports.createTokenRegex = createTokenRegex;
exports.dedupeBranchesAndIndexRoutes = dedupeBranchesAndIndexRoutes;
exports.determineInitialRoutePath = determineInitialRoutePath;
exports.determineNodePath = determineNodePath;
exports.findParent = findParent;
exports.format = format;
exports.getImportForRouteNode = getImportForRouteNode;
exports.getImportPath = getImportPath;
exports.getResolvedRouteNodeVariableName = getResolvedRouteNodeVariableName;
exports.hasEscapedLeadingUnderscore = hasEscapedLeadingUnderscore;
exports.hasEscapedTrailingUnderscore = hasEscapedTrailingUnderscore;
exports.hasParentRoute = hasParentRoute;
exports.inferFullPath = inferFullPath;
exports.inferPath = inferPath;
exports.inferTo = inferTo;
exports.isBracketWrappedSegment = isBracketWrappedSegment;
exports.isRouteNodeValidForAugmentation = isRouteNodeValidForAugmentation;
exports.isSegmentPathless = isSegmentPathless;
exports.mergeImportDeclarations = mergeImportDeclarations;
exports.multiSortBy = multiSortBy;
exports.removeExt = removeExt;
exports.removeGroups = removeGroups;
exports.removeLastSegmentFromPath = removeLastSegmentFromPath;
exports.removeLayoutSegments = removeLayoutSegments;
exports.removeLayoutSegmentsWithEscape = removeLayoutSegmentsWithEscape;
exports.removeLeadingSlash = removeLeadingSlash;
exports.removeTrailingSlash = removeTrailingSlash;
exports.removeUnderscores = removeUnderscores;
exports.removeUnderscoresWithEscape = removeUnderscoresWithEscape;
exports.replaceBackslash = replaceBackslash;
exports.resetRegex = resetRegex;
exports.routePathToVariable = routePathToVariable;
exports.trimPathLeft = trimPathLeft;
exports.unwrapBracketWrappedSegment = unwrapBracketWrappedSegment;
exports.writeIfDifferent = writeIfDifferent;
//# sourceMappingURL=utils.cjs.map
