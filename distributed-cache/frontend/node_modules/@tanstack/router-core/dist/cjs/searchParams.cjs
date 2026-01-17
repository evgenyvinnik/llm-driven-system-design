"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const qss = require("./qss.cjs");
const defaultParseSearch = parseSearchWith(JSON.parse);
const defaultStringifySearch = stringifySearchWith(
  JSON.stringify,
  JSON.parse
);
function parseSearchWith(parser) {
  return (searchStr) => {
    if (searchStr[0] === "?") {
      searchStr = searchStr.substring(1);
    }
    const query = qss.decode(searchStr);
    for (const key in query) {
      const value = query[key];
      if (typeof value === "string") {
        try {
          query[key] = parser(value);
        } catch (_err) {
        }
      }
    }
    return query;
  };
}
function stringifySearchWith(stringify, parser) {
  const hasParser = typeof parser === "function";
  function stringifyValue(val) {
    if (typeof val === "object" && val !== null) {
      try {
        return stringify(val);
      } catch (_err) {
      }
    } else if (hasParser && typeof val === "string") {
      try {
        parser(val);
        return stringify(val);
      } catch (_err) {
      }
    }
    return val;
  }
  return (search) => {
    const searchStr = qss.encode(search, stringifyValue);
    return searchStr ? `?${searchStr}` : "";
  };
}
exports.defaultParseSearch = defaultParseSearch;
exports.defaultStringifySearch = defaultStringifySearch;
exports.parseSearchWith = parseSearchWith;
exports.stringifySearchWith = stringifySearchWith;
//# sourceMappingURL=searchParams.cjs.map
