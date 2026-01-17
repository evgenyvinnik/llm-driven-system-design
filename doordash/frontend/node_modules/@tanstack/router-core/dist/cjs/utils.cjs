"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
function last(arr) {
  return arr[arr.length - 1];
}
function isFunction(d) {
  return typeof d === "function";
}
function functionalUpdate(updater, previous) {
  if (isFunction(updater)) {
    return updater(previous);
  }
  return updater;
}
const hasOwn = Object.prototype.hasOwnProperty;
function replaceEqualDeep(prev, _next, _depth = 0) {
  if (prev === _next) {
    return prev;
  }
  if (_depth > 500) return _next;
  const next = _next;
  const array = isPlainArray(prev) && isPlainArray(next);
  if (!array && !(isPlainObject(prev) && isPlainObject(next))) return next;
  const prevItems = array ? prev : getEnumerableOwnKeys(prev);
  if (!prevItems) return next;
  const nextItems = array ? next : getEnumerableOwnKeys(next);
  if (!nextItems) return next;
  const prevSize = prevItems.length;
  const nextSize = nextItems.length;
  const copy = array ? new Array(nextSize) : {};
  let equalItems = 0;
  for (let i = 0; i < nextSize; i++) {
    const key = array ? i : nextItems[i];
    const p = prev[key];
    const n = next[key];
    if (p === n) {
      copy[key] = p;
      if (array ? i < prevSize : hasOwn.call(prev, key)) equalItems++;
      continue;
    }
    if (p === null || n === null || typeof p !== "object" || typeof n !== "object") {
      copy[key] = n;
      continue;
    }
    const v = replaceEqualDeep(p, n, _depth + 1);
    copy[key] = v;
    if (v === p) equalItems++;
  }
  return prevSize === nextSize && equalItems === prevSize ? prev : copy;
}
function getEnumerableOwnKeys(o) {
  const keys = [];
  const names = Object.getOwnPropertyNames(o);
  for (const name of names) {
    if (!Object.prototype.propertyIsEnumerable.call(o, name)) return false;
    keys.push(name);
  }
  const symbols = Object.getOwnPropertySymbols(o);
  for (const symbol of symbols) {
    if (!Object.prototype.propertyIsEnumerable.call(o, symbol)) return false;
    keys.push(symbol);
  }
  return keys;
}
function isPlainObject(o) {
  if (!hasObjectPrototype(o)) {
    return false;
  }
  const ctor = o.constructor;
  if (typeof ctor === "undefined") {
    return true;
  }
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) {
    return false;
  }
  if (!prot.hasOwnProperty("isPrototypeOf")) {
    return false;
  }
  return true;
}
function hasObjectPrototype(o) {
  return Object.prototype.toString.call(o) === "[object Object]";
}
function isPlainArray(value) {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}
function deepEqual(a, b, opts) {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0, l = a.length; i < l; i++) {
      if (!deepEqual(a[i], b[i], opts)) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ignoreUndefined = opts?.ignoreUndefined ?? true;
    if (opts?.partial) {
      for (const k in b) {
        if (!ignoreUndefined || b[k] !== void 0) {
          if (!deepEqual(a[k], b[k], opts)) return false;
        }
      }
      return true;
    }
    let aCount = 0;
    if (!ignoreUndefined) {
      aCount = Object.keys(a).length;
    } else {
      for (const k in a) {
        if (a[k] !== void 0) aCount++;
      }
    }
    let bCount = 0;
    for (const k in b) {
      if (!ignoreUndefined || b[k] !== void 0) {
        bCount++;
        if (bCount > aCount || !deepEqual(a[k], b[k], opts)) return false;
      }
    }
    return aCount === bCount;
  }
  return false;
}
function createControlledPromise(onResolve) {
  let resolveLoadPromise;
  let rejectLoadPromise;
  const controlledPromise = new Promise((resolve, reject) => {
    resolveLoadPromise = resolve;
    rejectLoadPromise = reject;
  });
  controlledPromise.status = "pending";
  controlledPromise.resolve = (value) => {
    controlledPromise.status = "resolved";
    controlledPromise.value = value;
    resolveLoadPromise(value);
    onResolve?.(value);
  };
  controlledPromise.reject = (e) => {
    controlledPromise.status = "rejected";
    rejectLoadPromise(e);
  };
  return controlledPromise;
}
function isModuleNotFoundError(error) {
  if (typeof error?.message !== "string") return false;
  return error.message.startsWith("Failed to fetch dynamically imported module") || error.message.startsWith("error loading dynamically imported module") || error.message.startsWith("Importing a module script failed");
}
function isPromise(value) {
  return Boolean(
    value && typeof value === "object" && typeof value.then === "function"
  );
}
function findLast(array, predicate) {
  for (let i = array.length - 1; i >= 0; i--) {
    const item = array[i];
    if (predicate(item)) return item;
  }
  return void 0;
}
function sanitizePathSegment(segment) {
  return segment.replace(/[\x00-\x1f\x7f]/g, "");
}
function decodeSegment(segment) {
  let decoded;
  try {
    decoded = decodeURI(segment);
  } catch {
    decoded = segment.replaceAll(/%[0-9A-F]{2}/gi, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
  return sanitizePathSegment(decoded);
}
const SAFE_URL_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"];
function isDangerousProtocol(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return !SAFE_URL_PROTOCOLS.includes(parsed.protocol);
  } catch {
    return false;
  }
}
const HTML_ESCAPE_LOOKUP = {
  "&": "\\u0026",
  ">": "\\u003e",
  "<": "\\u003c",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029"
};
const HTML_ESCAPE_REGEX = /[&><\u2028\u2029]/g;
function escapeHtml(str) {
  return str.replace(HTML_ESCAPE_REGEX, (match) => HTML_ESCAPE_LOOKUP[match]);
}
function decodePath(path, decodeIgnore) {
  if (!path) return path;
  const re = decodeIgnore ? new RegExp(`${decodeIgnore.join("|")}`, "gi") : /%25|%5C/gi;
  let cursor = 0;
  let result = "";
  let match;
  while (null !== (match = re.exec(path))) {
    result += decodeSegment(path.slice(cursor, match.index)) + match[0];
    cursor = re.lastIndex;
  }
  result = result + decodeSegment(cursor ? path.slice(cursor) : path);
  if (result.startsWith("//")) {
    result = "/" + result.replace(/^\/+/, "");
  }
  return result;
}
function buildDevStylesUrl(basepath, routeIds) {
  const trimmedBasepath = basepath.replace(/^\/+|\/+$/g, "");
  const normalizedBasepath = trimmedBasepath === "" ? "" : `/${trimmedBasepath}`;
  return `${normalizedBasepath}/@tanstack-start/styles.css?routes=${encodeURIComponent(routeIds.join(","))}`;
}
exports.SAFE_URL_PROTOCOLS = SAFE_URL_PROTOCOLS;
exports.buildDevStylesUrl = buildDevStylesUrl;
exports.createControlledPromise = createControlledPromise;
exports.decodePath = decodePath;
exports.deepEqual = deepEqual;
exports.escapeHtml = escapeHtml;
exports.findLast = findLast;
exports.functionalUpdate = functionalUpdate;
exports.isDangerousProtocol = isDangerousProtocol;
exports.isModuleNotFoundError = isModuleNotFoundError;
exports.isPlainArray = isPlainArray;
exports.isPlainObject = isPlainObject;
exports.isPromise = isPromise;
exports.last = last;
exports.replaceEqualDeep = replaceEqualDeep;
//# sourceMappingURL=utils.cjs.map
