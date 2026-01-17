import path from "node:path";
import * as fsp from "node:fs/promises";
import { replaceBackslash, routePathToVariable, removeExt, determineInitialRoutePath, unwrapBracketWrappedSegment, hasEscapedLeadingUnderscore } from "../../utils.js";
import { getRouteNodes as getRouteNodes$1 } from "../virtual/getRouteNodes.js";
import { loadConfigFile } from "../virtual/loadConfigFile.js";
import { logging } from "../../logger.js";
import { rootPathId } from "./rootPathId.js";
const disallowedRouteGroupConfiguration = /\(([^)]+)\).(ts|js|tsx|jsx|vue)/;
const virtualConfigFileRegExp = /__virtual\.[mc]?[jt]s$/;
function isVirtualConfigFile(fileName) {
  return virtualConfigFileRegExp.test(fileName);
}
async function getRouteNodes(config, root, tokenRegexes) {
  const { routeFilePrefix, routeFileIgnorePrefix, routeFileIgnorePattern } = config;
  const logger = logging({ disabled: config.disableLogging });
  const routeFileIgnoreRegExp = new RegExp(routeFileIgnorePattern ?? "", "g");
  const routeNodes = [];
  const allPhysicalDirectories = [];
  async function recurse(dir) {
    const fullDir = path.resolve(config.routesDirectory, dir);
    let dirList = await fsp.readdir(fullDir, { withFileTypes: true });
    dirList = dirList.filter((d) => {
      if (d.name.startsWith(".") || routeFileIgnorePrefix && d.name.startsWith(routeFileIgnorePrefix)) {
        return false;
      }
      if (routeFilePrefix) {
        if (routeFileIgnorePattern) {
          return d.name.startsWith(routeFilePrefix) && !d.name.match(routeFileIgnoreRegExp);
        }
        return d.name.startsWith(routeFilePrefix);
      }
      if (routeFileIgnorePattern) {
        return !d.name.match(routeFileIgnoreRegExp);
      }
      return true;
    });
    const virtualConfigFile = dirList.find((dirent) => {
      return dirent.isFile() && isVirtualConfigFile(dirent.name);
    });
    if (virtualConfigFile !== void 0) {
      const virtualRouteConfigExport = await loadConfigFile(
        path.resolve(fullDir, virtualConfigFile.name)
      );
      let virtualRouteSubtreeConfig;
      if (typeof virtualRouteConfigExport.default === "function") {
        virtualRouteSubtreeConfig = await virtualRouteConfigExport.default();
      } else {
        virtualRouteSubtreeConfig = virtualRouteConfigExport.default;
      }
      const dummyRoot = {
        type: "root",
        file: "",
        children: virtualRouteSubtreeConfig
      };
      const { routeNodes: virtualRouteNodes, physicalDirectories } = await getRouteNodes$1(
        {
          ...config,
          routesDirectory: fullDir,
          virtualRouteConfig: dummyRoot
        },
        root,
        tokenRegexes
      );
      allPhysicalDirectories.push(...physicalDirectories);
      virtualRouteNodes.forEach((node) => {
        const filePath = replaceBackslash(path.join(dir, node.filePath));
        const routePath = `/${dir}${node.routePath}`;
        node.variableName = routePathToVariable(
          `${dir}/${removeExt(node.filePath)}`
        );
        node.routePath = routePath;
        if (node.originalRoutePath) {
          node.originalRoutePath = `/${dir}${node.originalRoutePath}`;
        }
        node.filePath = filePath;
      });
      routeNodes.push(...virtualRouteNodes);
      return;
    }
    await Promise.all(
      dirList.map(async (dirent) => {
        const fullPath = replaceBackslash(path.join(fullDir, dirent.name));
        const relativePath = path.posix.join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await recurse(relativePath);
        } else if (fullPath.match(/\.(tsx|ts|jsx|js|vue)$/)) {
          const filePath = replaceBackslash(path.join(dir, dirent.name));
          const filePathNoExt = removeExt(filePath);
          const {
            routePath: initialRoutePath,
            originalRoutePath: initialOriginalRoutePath
          } = determineInitialRoutePath(filePathNoExt);
          let routePath = initialRoutePath;
          let originalRoutePath = initialOriginalRoutePath;
          if (routeFilePrefix) {
            routePath = routePath.replaceAll(routeFilePrefix, "");
            originalRoutePath = originalRoutePath.replaceAll(
              routeFilePrefix,
              ""
            );
          }
          if (disallowedRouteGroupConfiguration.test(dirent.name)) {
            const errorMessage = `A route configuration for a route group was found at \`${filePath}\`. This is not supported. Did you mean to use a layout/pathless route instead?`;
            logger.error(`ERROR: ${errorMessage}`);
            throw new Error(errorMessage);
          }
          const meta = getRouteMeta(routePath, originalRoutePath, tokenRegexes);
          const variableName = meta.variableName;
          let routeType = meta.fsRouteType;
          if (routeType === "lazy") {
            routePath = routePath.replace(/\/lazy$/, "");
            originalRoutePath = originalRoutePath.replace(/\/lazy$/, "");
          }
          if (isValidPathlessLayoutRoute(
            routePath,
            originalRoutePath,
            routeType,
            tokenRegexes
          )) {
            routeType = "pathless_layout";
          }
          const isVueFile = filePath.endsWith(".vue");
          if (!isVueFile) {
            [
              ["component", "component"],
              ["errorComponent", "errorComponent"],
              ["notFoundComponent", "notFoundComponent"],
              ["pendingComponent", "pendingComponent"],
              ["loader", "loader"]
            ].forEach(([matcher, type]) => {
              if (routeType === matcher) {
                logger.warn(
                  `WARNING: The \`.${type}.tsx\` suffix used for the ${filePath} file is deprecated. Use the new \`.lazy.tsx\` suffix instead.`
                );
              }
            });
          }
          const originalSegments = originalRoutePath.split("/").filter(Boolean);
          const lastOriginalSegmentForSuffix = originalSegments[originalSegments.length - 1] || "";
          const { routeTokenSegmentRegex, indexTokenSegmentRegex } = tokenRegexes;
          const specialSuffixes = [
            "component",
            "errorComponent",
            "notFoundComponent",
            "pendingComponent",
            "loader",
            "lazy"
          ];
          const routePathSegments = routePath.split("/").filter(Boolean);
          const lastRouteSegment = routePathSegments[routePathSegments.length - 1] || "";
          const suffixToStrip = specialSuffixes.find((suffix) => {
            const endsWithSuffix = routePath.endsWith(`/${suffix}`);
            const isEscaped = lastOriginalSegmentForSuffix.startsWith("[") && lastOriginalSegmentForSuffix.endsWith("]") && unwrapBracketWrappedSegment(lastOriginalSegmentForSuffix) === suffix;
            return endsWithSuffix && !isEscaped;
          });
          const routeTokenCandidate = unwrapBracketWrappedSegment(
            lastOriginalSegmentForSuffix
          );
          const isRouteTokenEscaped = lastOriginalSegmentForSuffix !== routeTokenCandidate && routeTokenSegmentRegex.test(routeTokenCandidate);
          const shouldStripRouteToken = routeTokenSegmentRegex.test(lastRouteSegment) && !isRouteTokenEscaped;
          if (suffixToStrip || shouldStripRouteToken) {
            const stripSegment = suffixToStrip ?? lastRouteSegment;
            routePath = routePath.replace(new RegExp(`/${stripSegment}$`), "");
            originalRoutePath = originalRoutePath.replace(
              new RegExp(`/${stripSegment}$`),
              ""
            );
          }
          const lastOriginalSegment = originalRoutePath.split("/").filter(Boolean).pop() || "";
          const indexTokenCandidate = unwrapBracketWrappedSegment(lastOriginalSegment);
          const isIndexEscaped = lastOriginalSegment !== indexTokenCandidate && indexTokenSegmentRegex.test(indexTokenCandidate);
          if (!isIndexEscaped) {
            const updatedRouteSegments = routePath.split("/").filter(Boolean);
            const updatedLastRouteSegment = updatedRouteSegments[updatedRouteSegments.length - 1] || "";
            if (indexTokenSegmentRegex.test(updatedLastRouteSegment)) {
              if (routePathSegments.length === 1) {
                routePath = "/";
              }
              if (lastOriginalSegment === updatedLastRouteSegment) {
                originalRoutePath = "/";
              }
              const isLayoutRoute = routeType === "layout";
              routePath = routePath.replace(
                new RegExp(`/${updatedLastRouteSegment}$`),
                "/"
              ) || (isLayoutRoute ? "" : "/");
              originalRoutePath = originalRoutePath.replace(
                new RegExp(`/${indexTokenCandidate}$`),
                "/"
              ) || (isLayoutRoute ? "" : "/");
            }
          }
          routeNodes.push({
            filePath,
            fullPath,
            routePath,
            variableName,
            _fsRouteType: routeType,
            originalRoutePath
          });
        }
      })
    );
    return routeNodes;
  }
  await recurse("./");
  const rootRouteNode = routeNodes.find(
    (d) => d.routePath === `/${rootPathId}` && ![
      "component",
      "errorComponent",
      "notFoundComponent",
      "pendingComponent",
      "loader",
      "lazy"
    ].includes(d._fsRouteType)
  ) ?? routeNodes.find((d) => d.routePath === `/${rootPathId}`);
  if (rootRouteNode) {
    rootRouteNode._fsRouteType = "__root";
    rootRouteNode.variableName = "root";
  }
  return {
    rootRouteNode,
    routeNodes,
    physicalDirectories: allPhysicalDirectories
  };
}
function getRouteMeta(routePath, originalRoutePath, tokenRegexes) {
  let fsRouteType = "static";
  const originalSegments = originalRoutePath.split("/").filter(Boolean);
  const lastOriginalSegment = originalSegments[originalSegments.length - 1] || "";
  const { routeTokenSegmentRegex } = tokenRegexes;
  const isSuffixEscaped = (suffix) => {
    return lastOriginalSegment.startsWith("[") && lastOriginalSegment.endsWith("]") && unwrapBracketWrappedSegment(lastOriginalSegment) === suffix;
  };
  const routeSegments = routePath.split("/").filter(Boolean);
  const lastRouteSegment = routeSegments[routeSegments.length - 1] || "";
  const routeTokenCandidate = unwrapBracketWrappedSegment(lastOriginalSegment);
  const isRouteTokenEscaped = lastOriginalSegment !== routeTokenCandidate && routeTokenSegmentRegex.test(routeTokenCandidate);
  if (routeTokenSegmentRegex.test(lastRouteSegment) && !isRouteTokenEscaped) {
    fsRouteType = "layout";
  } else if (routePath.endsWith("/lazy") && !isSuffixEscaped("lazy")) {
    fsRouteType = "lazy";
  } else if (routePath.endsWith("/loader") && !isSuffixEscaped("loader")) {
    fsRouteType = "loader";
  } else if (routePath.endsWith("/component") && !isSuffixEscaped("component")) {
    fsRouteType = "component";
  } else if (routePath.endsWith("/pendingComponent") && !isSuffixEscaped("pendingComponent")) {
    fsRouteType = "pendingComponent";
  } else if (routePath.endsWith("/errorComponent") && !isSuffixEscaped("errorComponent")) {
    fsRouteType = "errorComponent";
  } else if (routePath.endsWith("/notFoundComponent") && !isSuffixEscaped("notFoundComponent")) {
    fsRouteType = "notFoundComponent";
  }
  const variableName = routePathToVariable(routePath);
  return { fsRouteType, variableName };
}
function isValidPathlessLayoutRoute(normalizedRoutePath, originalRoutePath, routeType, tokenRegexes) {
  if (routeType === "lazy") {
    return false;
  }
  const segments = normalizedRoutePath.split("/").filter(Boolean);
  const originalSegments = originalRoutePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return false;
  }
  const lastRouteSegment = segments[segments.length - 1];
  const lastOriginalSegment = originalSegments[originalSegments.length - 1] || "";
  const secondToLastRouteSegment = segments[segments.length - 2];
  const secondToLastOriginalSegment = originalSegments[originalSegments.length - 2];
  if (lastRouteSegment === rootPathId) {
    return false;
  }
  const { routeTokenSegmentRegex, indexTokenSegmentRegex } = tokenRegexes;
  if (routeTokenSegmentRegex.test(lastRouteSegment) && typeof secondToLastRouteSegment === "string" && typeof secondToLastOriginalSegment === "string") {
    if (hasEscapedLeadingUnderscore(secondToLastOriginalSegment)) {
      return false;
    }
    return secondToLastRouteSegment.startsWith("_");
  }
  if (hasEscapedLeadingUnderscore(lastOriginalSegment)) {
    return false;
  }
  return !indexTokenSegmentRegex.test(lastRouteSegment) && !routeTokenSegmentRegex.test(lastRouteSegment) && lastRouteSegment.startsWith("_");
}
export {
  getRouteMeta,
  getRouteNodes,
  isVirtualConfigFile
};
//# sourceMappingURL=getRouteNodes.js.map
