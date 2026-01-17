"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const node_url = require("node:url");
const routerUtils = require("@tanstack/router-utils");
const config = require("./config.cjs");
const compilers = require("./code-splitter/compilers.cjs");
const constants = require("./constants.cjs");
const pathIds = require("./code-splitter/path-ids.cjs");
const utils = require("./utils.cjs");
const bannedBeforeExternalPlugins = [
  {
    identifier: "@react-refresh",
    pkg: "@vitejs/plugin-react",
    usage: "viteReact()",
    frameworks: ["vite"]
  }
];
class FoundPluginInBeforeCode extends Error {
  constructor(externalPlugin, pluginFramework) {
    super(`We detected that the '${externalPlugin.pkg}' was passed before '@tanstack/router-plugin/${pluginFramework}'. Please make sure that '@tanstack/router-plugin' is passed before '${externalPlugin.pkg}' and try again: 
e.g.
plugins: [
  tanstackRouter(), // Place this before ${externalPlugin.usage}
  ${externalPlugin.usage},
]
`);
  }
}
const PLUGIN_NAME = "unplugin:router-code-splitter";
const unpluginRouterCodeSplitterFactory = (options = {}, { framework }) => {
  let ROOT = process.cwd();
  let userConfig;
  function initUserConfig() {
    if (typeof options === "function") {
      userConfig = options();
    } else {
      userConfig = config.getConfig(options, ROOT);
    }
  }
  const isProduction = process.env.NODE_ENV === "production";
  const getGlobalCodeSplitGroupings = () => {
    return userConfig.codeSplittingOptions?.defaultBehavior || constants.defaultCodeSplitGroupings;
  };
  const getShouldSplitFn = () => {
    return userConfig.codeSplittingOptions?.splitBehavior;
  };
  const handleCompilingReferenceFile = (code, id, generatorNodeInfo) => {
    if (utils.debug) console.info("Compiling Route: ", id);
    const fromCode = compilers.detectCodeSplitGroupingsFromRoute({
      code
    });
    if (fromCode.groupings) {
      const res = config.splitGroupingsSchema.safeParse(fromCode.groupings);
      if (!res.success) {
        const message = res.error.errors.map((e) => e.message).join(". ");
        throw new Error(
          `The groupings for the route "${id}" are invalid.
${message}`
        );
      }
    }
    const userShouldSplitFn = getShouldSplitFn();
    const pluginSplitBehavior = userShouldSplitFn?.({
      routeId: generatorNodeInfo.routePath
    });
    if (pluginSplitBehavior) {
      const res = config.splitGroupingsSchema.safeParse(pluginSplitBehavior);
      if (!res.success) {
        const message = res.error.errors.map((e) => e.message).join(". ");
        throw new Error(
          `The groupings returned when using \`splitBehavior\` for the route "${id}" are invalid.
${message}`
        );
      }
    }
    const splitGroupings = fromCode.groupings || pluginSplitBehavior || getGlobalCodeSplitGroupings();
    const compiledReferenceRoute = compilers.compileCodeSplitReferenceRoute({
      code,
      codeSplitGroupings: splitGroupings,
      targetFramework: userConfig.target,
      filename: id,
      id,
      deleteNodes: userConfig.codeSplittingOptions?.deleteNodes ? new Set(userConfig.codeSplittingOptions.deleteNodes) : void 0,
      addHmr: (userConfig.codeSplittingOptions?.addHmr ?? true) && !isProduction
    });
    if (compiledReferenceRoute === null) {
      if (utils.debug) {
        console.info(
          `No changes made to route "${id}", skipping code-splitting.`
        );
      }
      return null;
    }
    if (utils.debug) {
      routerUtils.logDiff(code, compiledReferenceRoute.code);
      console.log("Output:\n", compiledReferenceRoute.code + "\n\n");
    }
    return compiledReferenceRoute;
  };
  const handleCompilingVirtualFile = (code, id) => {
    if (utils.debug) console.info("Splitting Route: ", id);
    const [_, ...pathnameParts] = id.split("?");
    const searchParams = new URLSearchParams(pathnameParts.join("?"));
    const splitValue = searchParams.get(constants.tsrSplit);
    if (!splitValue) {
      throw new Error(
        `The split value for the virtual route "${id}" was not found.`
      );
    }
    const rawGrouping = pathIds.decodeIdentifier(splitValue);
    const grouping = [...new Set(rawGrouping)].filter(
      (p) => constants.splitRouteIdentNodes.includes(p)
    );
    const result = compilers.compileCodeSplitVirtualRoute({
      code,
      filename: id,
      splitTargets: grouping
    });
    if (utils.debug) {
      routerUtils.logDiff(code, result.code);
      console.log("Output:\n", result.code + "\n\n");
    }
    return result;
  };
  const includedCode = [
    "createFileRoute(",
    "createRootRoute(",
    "createRootRouteWithContext("
  ];
  return [
    {
      name: "tanstack-router:code-splitter:compile-reference-file",
      enforce: "pre",
      transform: {
        filter: {
          id: {
            exclude: constants.tsrSplit,
            // this is necessary for webpack / rspack to avoid matching .html files
            include: /\.(m|c)?(j|t)sx?$/
          },
          code: {
            include: includedCode
          }
        },
        handler(code, id) {
          const normalizedId = utils.normalizePath(id);
          const generatorFileInfo = globalThis.TSR_ROUTES_BY_ID_MAP?.get(normalizedId);
          if (generatorFileInfo && includedCode.some((included) => code.includes(included))) {
            for (const externalPlugin of bannedBeforeExternalPlugins) {
              if (!externalPlugin.frameworks.includes(framework)) {
                continue;
              }
              if (code.includes(externalPlugin.identifier)) {
                throw new FoundPluginInBeforeCode(externalPlugin, framework);
              }
            }
            return handleCompilingReferenceFile(
              code,
              normalizedId,
              generatorFileInfo
            );
          }
          return null;
        }
      },
      vite: {
        configResolved(config2) {
          ROOT = config2.root;
          initUserConfig();
        },
        applyToEnvironment(environment) {
          if (userConfig.plugin?.vite?.environmentName) {
            return userConfig.plugin.vite.environmentName === environment.name;
          }
          return true;
        }
      },
      rspack(compiler) {
        ROOT = process.cwd();
        initUserConfig();
        if (compiler.options.mode === "production") {
          compiler.hooks.done.tap(PLUGIN_NAME, () => {
            console.info("✅ " + PLUGIN_NAME + ": code-splitting done!");
          });
        }
      },
      webpack(compiler) {
        ROOT = process.cwd();
        initUserConfig();
        if (compiler.options.mode === "production") {
          compiler.hooks.done.tap(PLUGIN_NAME, () => {
            console.info("✅ " + PLUGIN_NAME + ": code-splitting done!");
          });
        }
      }
    },
    {
      name: "tanstack-router:code-splitter:compile-virtual-file",
      enforce: "pre",
      transform: {
        filter: {
          id: /tsr-split/
        },
        handler(code, id) {
          const url = node_url.pathToFileURL(id);
          url.searchParams.delete("v");
          const normalizedId = utils.normalizePath(node_url.fileURLToPath(url));
          return handleCompilingVirtualFile(code, normalizedId);
        }
      }
    }
  ];
};
exports.unpluginRouterCodeSplitterFactory = unpluginRouterCodeSplitterFactory;
//# sourceMappingURL=router-code-splitter-plugin.cjs.map
