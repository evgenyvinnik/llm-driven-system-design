"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const routerUtils = require("@tanstack/router-utils");
const babel = require("@babel/core");
const template = require("@babel/template");
const config = require("./config.cjs");
const utils = require("./utils.cjs");
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
const template__namespace = /* @__PURE__ */ _interopNamespaceDefault(template);
const unpluginRouteAutoImportFactory = (options = {}) => {
  let ROOT = process.cwd();
  let userConfig;
  function initUserConfig() {
    if (typeof options === "function") {
      userConfig = options();
    } else {
      userConfig = config.getConfig(options, ROOT);
    }
  }
  return {
    name: "tanstack-router:autoimport",
    enforce: "pre",
    transform: {
      filter: {
        // this is necessary for webpack / rspack to avoid matching .html files
        id: /\.(m|c)?(j|t)sx?$/,
        code: /createFileRoute\(|createLazyFileRoute\(/
      },
      handler(code, id) {
        const normalizedId = utils.normalizePath(id);
        if (!globalThis.TSR_ROUTES_BY_ID_MAP?.has(normalizedId)) {
          return null;
        }
        let routeType;
        if (code.includes("createFileRoute(")) {
          routeType = "createFileRoute";
        } else if (code.includes("createLazyFileRoute(")) {
          routeType = "createLazyFileRoute";
        } else {
          return null;
        }
        const routerImportPath = `@tanstack/${userConfig.target}-router`;
        const ast = routerUtils.parseAst({ code });
        let isCreateRouteFunctionImported = false;
        babel.traverse(ast, {
          Program: {
            enter(programPath) {
              programPath.traverse({
                ImportDeclaration(path) {
                  const importedSpecifiers = path.node.specifiers.map(
                    (specifier) => specifier.local.name
                  );
                  if (importedSpecifiers.includes(routeType) && path.node.source.value === routerImportPath) {
                    isCreateRouteFunctionImported = true;
                  }
                }
              });
            }
          }
        });
        if (!isCreateRouteFunctionImported) {
          if (utils.debug) console.info("Adding autoimports to route ", normalizedId);
          const autoImportStatement = template__namespace.statement(
            `import { ${routeType} } from '${routerImportPath}'`
          )();
          ast.program.body.unshift(autoImportStatement);
          const result = routerUtils.generateFromAst(ast, {
            sourceMaps: true,
            filename: normalizedId,
            sourceFileName: normalizedId
          });
          if (utils.debug) {
            routerUtils.logDiff(code, result.code);
            console.log("Output:\n", result.code + "\n\n");
          }
          return result;
        }
        return null;
      }
    },
    vite: {
      configResolved(config2) {
        ROOT = config2.root;
        initUserConfig();
      },
      // this check may only happen after config is resolved, so we use applyToEnvironment (apply is too early)
      applyToEnvironment() {
        return userConfig.verboseFileRoutes === false;
      }
    },
    rspack() {
      ROOT = process.cwd();
      initUserConfig();
    },
    webpack() {
      ROOT = process.cwd();
      initUserConfig();
    }
  };
};
exports.unpluginRouteAutoImportFactory = unpluginRouteAutoImportFactory;
//# sourceMappingURL=route-autoimport-plugin.cjs.map
