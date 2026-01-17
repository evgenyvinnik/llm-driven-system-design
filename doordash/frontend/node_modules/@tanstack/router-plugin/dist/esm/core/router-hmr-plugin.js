import { parseAst, generateFromAst, logDiff } from "@tanstack/router-utils";
import { routeHmrStatement } from "./route-hmr-statement.js";
import { normalizePath, debug } from "./utils.js";
import { getConfig } from "./config.js";
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
        const normalizedId = normalizePath(id);
        if (!globalThis.TSR_ROUTES_BY_ID_MAP?.has(normalizedId)) {
          return null;
        }
        if (debug) console.info("Adding HMR handling to route ", normalizedId);
        const ast = parseAst({ code });
        ast.program.body.push(routeHmrStatement);
        const result = generateFromAst(ast, {
          sourceMaps: true,
          filename: normalizedId,
          sourceFileName: normalizedId
        });
        if (debug) {
          logDiff(code, result.code);
          console.log("Output:\n", result.code + "\n\n");
        }
        return result;
      }
    },
    vite: {
      configResolved(config) {
        ROOT = config.root;
        userConfig = getConfig(options, ROOT);
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
export {
  unpluginRouterHmrFactory
};
//# sourceMappingURL=router-hmr-plugin.js.map
