"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const routerUtils = require("@tanstack/router-utils");
const routeHmrStatement = require("./route-hmr-statement.cjs");
const utils = require("./utils.cjs");
const config = require("./config.cjs");
const includeCode = [
  "createFileRoute(",
  "createRootRoute(",
  "createRootRouteWithContext("
];
const unpluginRouterHmrFactory = (options = {}) => {
  let ROOT = process.cwd();
  let userConfig = options;
  return {
    name: "tanstack-router:hmr",
    enforce: "pre",
    transform: {
      filter: {
        // this is necessary for webpack / rspack to avoid matching .html files
        id: /\.(m|c)?(j|t)sx?$/,
        code: {
          include: includeCode
        }
      },
      handler(code, id) {
        const normalizedId = utils.normalizePath(id);
        if (!globalThis.TSR_ROUTES_BY_ID_MAP?.has(normalizedId)) {
          return null;
        }
        if (utils.debug) console.info("Adding HMR handling to route ", normalizedId);
        const ast = routerUtils.parseAst({ code });
        ast.program.body.push(routeHmrStatement.routeHmrStatement);
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
    },
    vite: {
      configResolved(config$1) {
        ROOT = config$1.root;
        userConfig = config.getConfig(options, ROOT);
      },
      applyToEnvironment(environment) {
        if (userConfig.plugin?.vite?.environmentName) {
          return userConfig.plugin.vite.environmentName === environment.name;
        }
        return true;
      }
    }
  };
};
exports.unpluginRouterHmrFactory = unpluginRouterHmrFactory;
//# sourceMappingURL=router-hmr-plugin.cjs.map
