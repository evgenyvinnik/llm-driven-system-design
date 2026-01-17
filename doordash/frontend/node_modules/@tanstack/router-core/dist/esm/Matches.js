const isMatch = (match, path) => {
  const parts = path.split(".");
  let part;
  let i = 0;
  let value = match;
  while ((part = parts[i++]) != null && value != null) {
    value = value[part];
  }
  return value != null;
};
export {
  isMatch
};
//# sourceMappingURL=Matches.js.map
