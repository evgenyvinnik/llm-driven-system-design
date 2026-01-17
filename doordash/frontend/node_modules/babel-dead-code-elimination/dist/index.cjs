"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  deadCodeElimination: () => dead_code_elimination_default,
  findReferencedIdentifiers: () => find_referenced_identifiers_default
});
module.exports = __toCommonJS(src_exports);

// node_modules/.pnpm/tsup@8.0.2_postcss@8.4.38_typescript@5.4.5/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL("file:" + __filename).href : document.currentScript && document.currentScript.src || new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/babel-esm.ts
var import_core = require("@babel/core");
var import_parser = require("@babel/parser");
var t = __toESM(require("@babel/types"), 1);
var import_node_module = require("module");
var require2 = (0, import_node_module.createRequire)(importMetaUrl);
var _traverse = require2("@babel/traverse");
var traverse = _traverse.default;

// src/errors.ts
function unexpected(path) {
  let type = path.node === null ? "null" : path.node.type;
  return path.buildCodeFrameError(
    `[babel-dead-code-elimination] unexpected node type: ${type}`
  );
}

// src/pattern.ts
function findVariables(patternPath) {
  let variables = [];
  function recurse(path) {
    if (path.isIdentifier()) {
      variables.push(path);
      return;
    }
    if (path.isObjectPattern()) {
      return path.get("properties").forEach(recurse);
    }
    if (path.isObjectProperty()) {
      return recurse(path.get("value"));
    }
    if (path.isArrayPattern()) {
      let _elements = path.get("elements");
      return _elements.forEach(recurse);
    }
    if (path.isAssignmentPattern()) {
      return recurse(path.get("left"));
    }
    if (path.isRestElement()) {
      return recurse(path.get("argument"));
    }
    if (path.node === null)
      return;
    throw unexpected(path);
  }
  recurse(patternPath);
  return variables;
}
function remove(path) {
  let parent = path.parentPath;
  if (parent.isVariableDeclarator()) {
    return parent.remove();
  }
  if (parent.isArrayPattern()) {
    parent.node.elements[path.key] = null;
    return;
  }
  if (parent.isObjectProperty()) {
    return parent.remove();
  }
  if (parent.isRestElement()) {
    return parent.remove();
  }
  if (parent.isAssignmentPattern()) {
    if (t.isObjectProperty(parent.parent)) {
      return parent.parentPath.remove();
    }
    if (t.isArrayPattern(parent.parent)) {
      parent.parent.elements[parent.key] = null;
      return;
    }
    throw unexpected(parent.parentPath);
  }
  throw unexpected(parent);
}

// src/find-removable-bindings.ts
function findRemovableBindings(programPath) {
  const allBindings = Object.values(programPath.scope.bindings);
  const n = allBindings.length;
  if (n === 0)
    return /* @__PURE__ */ new Set();
  const pathNodeToIdx = /* @__PURE__ */ new Map();
  const refs = new Array(n);
  for (let i = 0; i < n; i++) {
    const b = allBindings[i];
    if (b.path?.node)
      pathNodeToIdx.set(b.path.node, i);
    refs[i] = null;
  }
  const excluded = new Uint8Array(n);
  const exclusionQueue = [];
  let candidateCount = n;
  for (let i = 0; i < n; i++) {
    const binding = allBindings[i];
    if (binding.constantViolations.length > 0 || isLoopIteratorBinding(binding)) {
      excluded[i] = 1;
      candidateCount--;
      exclusionQueue.push(i);
      continue;
    }
    for (const refPath of binding.referencePaths) {
      let path = refPath;
      let containerIdx;
      while (path) {
        containerIdx = pathNodeToIdx.get(path.node);
        if (containerIdx !== void 0)
          break;
        path = path.parentPath;
      }
      if (containerIdx !== void 0) {
        const containerRefs = refs[containerIdx];
        if (!containerRefs) {
          refs[containerIdx] = [i];
        } else if (!containerRefs.includes(i)) {
          containerRefs.push(i);
        }
      } else if (!excluded[i]) {
        excluded[i] = 1;
        candidateCount--;
        exclusionQueue.push(i);
        break;
      }
    }
  }
  while (exclusionQueue.length > 0) {
    const idx = exclusionQueue.pop();
    const targets = refs[idx];
    if (targets) {
      for (const target of targets) {
        if (!excluded[target]) {
          excluded[target] = 1;
          candidateCount--;
          exclusionQueue.push(target);
        }
      }
    }
  }
  if (candidateCount === 0)
    return /* @__PURE__ */ new Set();
  if (candidateCount <= 3) {
    const candidates = [];
    for (let i = 0; i < n && candidates.length < candidateCount; i++) {
      if (!excluded[i])
        candidates.push(i);
    }
    if (candidateCount === 1) {
      const idx = candidates[0];
      return refs[idx]?.includes(idx) ? /* @__PURE__ */ new Set([allBindings[idx]]) : /* @__PURE__ */ new Set();
    }
    if (candidateCount === 2) {
      const [aIdx2, bIdx2] = candidates;
      const aRefs2 = refs[aIdx2];
      const bRefs2 = refs[bIdx2];
      const aRefsB2 = aRefs2?.includes(bIdx2);
      const bRefsA2 = bRefs2?.includes(aIdx2);
      if (aRefsB2 && bRefsA2) {
        return /* @__PURE__ */ new Set([allBindings[aIdx2], allBindings[bIdx2]]);
      }
      const result2 = /* @__PURE__ */ new Set();
      if (aRefs2?.includes(aIdx2))
        result2.add(allBindings[aIdx2]);
      if (bRefs2?.includes(bIdx2))
        result2.add(allBindings[bIdx2]);
      return result2;
    }
    const [aIdx, bIdx, cIdx] = candidates;
    const aRefs = refs[aIdx];
    const bRefs = refs[bIdx];
    const cRefs = refs[cIdx];
    const aRefsB = aRefs?.includes(bIdx), aRefsC = aRefs?.includes(cIdx);
    const bRefsA = bRefs?.includes(aIdx), bRefsC = bRefs?.includes(cIdx);
    const cRefsA = cRefs?.includes(aIdx), cRefsB = cRefs?.includes(bIdx);
    if (aRefsB && bRefsC && cRefsA || aRefsC && cRefsB && bRefsA) {
      return /* @__PURE__ */ new Set([
        allBindings[aIdx],
        allBindings[bIdx],
        allBindings[cIdx]
      ]);
    }
    const result = /* @__PURE__ */ new Set();
    if (aRefsB && bRefsA && !cRefsA && !cRefsB) {
      result.add(allBindings[aIdx]);
      result.add(allBindings[bIdx]);
    }
    if (aRefsC && cRefsA && !bRefsA && !bRefsC) {
      result.add(allBindings[aIdx]);
      result.add(allBindings[cIdx]);
    }
    if (bRefsC && cRefsB && !aRefsB && !aRefsC) {
      result.add(allBindings[bIdx]);
      result.add(allBindings[cIdx]);
    }
    if (aRefs?.includes(aIdx))
      result.add(allBindings[aIdx]);
    if (bRefs?.includes(bIdx))
      result.add(allBindings[bIdx]);
    if (cRefs?.includes(cIdx))
      result.add(allBindings[cIdx]);
    return result;
  }
  const indices = new Int32Array(n).fill(-1);
  const lowlink = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = [];
  const sccs = [];
  const sccId = new Int32Array(n).fill(-1);
  let index = 0;
  const strongconnect = (v) => {
    indices[v] = lowlink[v] = index++;
    stack.push(v);
    onStack[v] = 1;
    const neighbors = refs[v];
    if (neighbors) {
      for (const w of neighbors) {
        if (excluded[w])
          continue;
        if (indices[w] === -1) {
          strongconnect(w);
          if (lowlink[w] < lowlink[v])
            lowlink[v] = lowlink[w];
        } else if (onStack[w]) {
          if (indices[w] < lowlink[v])
            lowlink[v] = indices[w];
        }
      }
    }
    if (lowlink[v] === indices[v]) {
      const comp = [];
      let w;
      const compId = sccs.length;
      do {
        w = stack.pop();
        onStack[w] = 0;
        sccId[w] = compId;
        comp.push(w);
      } while (w !== v);
      sccs.push(comp);
    }
  };
  for (let v = 0; v < n; v++) {
    if (!excluded[v] && indices[v] === -1)
      strongconnect(v);
  }
  const hasIncoming = new Uint8Array(sccs.length);
  for (let src = 0; src < n; src++) {
    if (excluded[src])
      continue;
    const srcId = sccId[src];
    const neighbors = refs[src];
    if (neighbors) {
      for (const dst of neighbors) {
        if (excluded[dst])
          continue;
        const dstId = sccId[dst];
        if (srcId !== dstId)
          hasIncoming[dstId] = 1;
      }
    }
  }
  const removable = /* @__PURE__ */ new Set();
  for (let compId = 0; compId < sccs.length; compId++) {
    const comp = sccs[compId];
    if (comp.length === 1) {
      const idx = comp[0];
      if (refs[idx]?.includes(idx))
        removable.add(allBindings[idx]);
      continue;
    }
    if (!hasIncoming[compId]) {
      for (const idx of comp)
        removable.add(allBindings[idx]);
    }
  }
  return removable;
}
function isLoopIteratorBinding(binding) {
  if (binding.path.type === "VariableDeclarator") {
    const declPath = binding.path.parentPath;
    if (declPath?.key === "left" && (declPath.parent.type === "ForOfStatement" || declPath.parent.type === "ForInStatement")) {
      return true;
    }
  }
  return false;
}

// src/dead-code-elimination.ts
function dead_code_elimination_default(ast, candidates) {
  let removals;
  let removableBindings = /* @__PURE__ */ new Set();
  const hasCandidates = candidates !== void 0;
  const shouldBeRemoved = (ident) => {
    if (hasCandidates && !candidates.has(ident))
      return false;
    const binding = ident.scope.getBinding(ident.node.name);
    if (binding && removableBindings.has(binding))
      return true;
    if (binding?.referenced)
      return false;
    if (binding && binding.constantViolations.length > 0)
      return false;
    if (binding && isLoopIteratorBinding(binding))
      return false;
    const grandParent = ident.parentPath.parentPath;
    if (grandParent?.isObjectPattern()) {
      if (ident.parentPath.isRestElement())
        return true;
      return !grandParent.get("properties").at(-1)?.isRestElement();
    }
    if (hasCandidates)
      return candidates.has(ident);
    return true;
  };
  do {
    removals = 0;
    traverse(ast, {
      Program(path) {
        path.scope.crawl();
        removableBindings = findRemovableBindings(path);
      },
      ImportDeclaration(path) {
        let removalsBefore = removals;
        for (let specifier of path.get("specifiers")) {
          let local = specifier.get("local");
          if (shouldBeRemoved(local)) {
            specifier.remove();
            removals++;
          }
        }
        if (removals > removalsBefore && path.node.specifiers.length === 0) {
          path.remove();
        }
      },
      VariableDeclarator(path) {
        let id = path.get("id");
        if (id.isIdentifier()) {
          if (shouldBeRemoved(id)) {
            path.remove();
            removals++;
          }
        } else if (id.isObjectPattern() || id.isArrayPattern()) {
          for (let variable of findVariables(id)) {
            if (!shouldBeRemoved(variable))
              continue;
            let parent = variable.parentPath;
            if (parent.isObjectProperty()) {
              parent.remove();
              removals++;
              continue;
            }
            if (parent.isArrayPattern()) {
              parent.node.elements[variable.key] = null;
              removals++;
              continue;
            }
            if (parent.isAssignmentPattern()) {
              if (t.isObjectProperty(parent.parent)) {
                parent.parentPath?.remove();
                removals++;
                continue;
              }
              if (t.isArrayPattern(parent.parent)) {
                parent.parent.elements[parent.key] = null;
                removals++;
                continue;
              }
              throw unexpected(parent);
            }
            if (parent.isRestElement()) {
              parent.remove();
              removals++;
              continue;
            }
            throw unexpected(parent);
          }
        }
      },
      ObjectPattern(path) {
        let isWithinDeclarator = path.find((p) => p.isVariableDeclarator()) !== null;
        let isFunctionParam = path.parentPath.isFunction() && path.parentPath.node.params.includes(path.node);
        let isEmpty = path.node.properties.length === 0;
        if (isWithinDeclarator && !isFunctionParam && isEmpty) {
          remove(path);
          removals++;
        }
      },
      ArrayPattern(path) {
        let isWithinDeclarator = path.find((p) => p.isVariableDeclarator()) !== null;
        let isFunctionParam = path.parentPath.isFunction() && path.parentPath.node.params.includes(path.node);
        let isEmpty = path.node.elements.every((e) => e === null);
        if (isWithinDeclarator && !isFunctionParam && isEmpty) {
          remove(path);
          removals++;
        }
      },
      FunctionDeclaration(path) {
        let id = path.get("id");
        if (id.isIdentifier() && shouldBeRemoved(id)) {
          removals++;
          if (t.isAssignmentExpression(path.parentPath.node) || t.isVariableDeclarator(path.parentPath.node)) {
            path.parentPath.remove();
          } else {
            path.remove();
          }
        }
      }
    });
  } while (removals > 0);
}

// src/find-referenced-identifiers.ts
function addIfReferenced(ident, removable, referenced) {
  const binding = ident.scope.getBinding(ident.node.name);
  if (binding && !removable.has(binding) && binding.referenced) {
    referenced.add(ident);
  }
}
function find_referenced_identifiers_default(ast) {
  const referenced = /* @__PURE__ */ new Set();
  let removable;
  traverse(ast, {
    Program(path) {
      path.scope.crawl();
      removable = findRemovableBindings(path);
    },
    ImportDeclaration(path) {
      for (const specifier of path.get("specifiers")) {
        addIfReferenced(specifier.get("local"), removable, referenced);
      }
    },
    VariableDeclarator(path) {
      const id = path.get("id");
      if (id.isIdentifier()) {
        addIfReferenced(id, removable, referenced);
      } else if (id.isObjectPattern() || id.isArrayPattern()) {
        for (const variable of findVariables(id)) {
          addIfReferenced(variable, removable, referenced);
        }
      }
    },
    FunctionDeclaration(path) {
      const id = path.get("id");
      if (id.isIdentifier()) {
        addIfReferenced(id, removable, referenced);
      }
    }
  });
  return referenced;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  deadCodeElimination,
  findReferencedIdentifiers
});
