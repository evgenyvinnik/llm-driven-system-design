function notFound(options = {}) {
  options.isNotFound = true;
  if (options.throw) throw options;
  return options;
}
function isNotFound(obj) {
  return !!obj?.isNotFound;
}
export {
  isNotFound,
  notFound
};
//# sourceMappingURL=not-found.js.map
