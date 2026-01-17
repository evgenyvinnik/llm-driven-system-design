const debug = process.env.TSR_VITE_DEBUG && ["true", "router-plugin"].includes(process.env.TSR_VITE_DEBUG);
function normalizePath(path) {
  return path.replace(/\\/g, "/");
}
export {
  debug,
  normalizePath
};
//# sourceMappingURL=utils.js.map
