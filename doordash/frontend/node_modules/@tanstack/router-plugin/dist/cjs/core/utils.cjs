"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const debug = process.env.TSR_VITE_DEBUG && ["true", "router-plugin"].includes(process.env.TSR_VITE_DEBUG);
function normalizePath(path) {
  return path.replace(/\\/g, "/");
}
exports.debug = debug;
exports.normalizePath = normalizePath;
//# sourceMappingURL=utils.cjs.map
