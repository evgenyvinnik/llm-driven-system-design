"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
function rootRoute(file, children) {
  return {
    type: "root",
    file,
    children
  };
}
function index(file) {
  return {
    type: "index",
    file
  };
}
function layout(idOrFile, fileOrChildren, children) {
  if (Array.isArray(fileOrChildren)) {
    return {
      type: "layout",
      file: idOrFile,
      children: fileOrChildren
    };
  } else {
    return {
      type: "layout",
      id: idOrFile,
      file: fileOrChildren,
      children
    };
  }
}
function route(path, fileOrChildren, children) {
  if (typeof fileOrChildren === "string") {
    return {
      type: "route",
      file: fileOrChildren,
      path,
      children
    };
  }
  return {
    type: "route",
    path,
    children: fileOrChildren
  };
}
function physical(pathPrefixOrDirectory, directory) {
  if (directory === void 0) {
    return {
      type: "physical",
      directory: pathPrefixOrDirectory,
      pathPrefix: ""
    };
  }
  return {
    type: "physical",
    directory,
    pathPrefix: pathPrefixOrDirectory
  };
}
exports.index = index;
exports.layout = layout;
exports.physical = physical;
exports.rootRoute = rootRoute;
exports.route = route;
//# sourceMappingURL=api.cjs.map
