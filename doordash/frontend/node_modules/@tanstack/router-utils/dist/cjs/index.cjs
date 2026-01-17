"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const ast = require("./ast.cjs");
const logger = require("./logger.cjs");
const copyFilesPlugin = require("./copy-files-plugin.cjs");
exports.generateFromAst = ast.generateFromAst;
exports.parseAst = ast.parseAst;
exports.logDiff = logger.logDiff;
exports.copyFilesPlugin = copyFilesPlugin.copyFilesPlugin;
//# sourceMappingURL=index.cjs.map
