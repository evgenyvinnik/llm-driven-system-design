"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const web = require("seroval-plugins/web");
const ShallowErrorPlugin = require("./ShallowErrorPlugin.cjs");
const RawStream = require("./RawStream.cjs");
const defaultSerovalPlugins = [
  ShallowErrorPlugin.ShallowErrorPlugin,
  // RawStreamSSRPlugin must come before ReadableStreamPlugin to match first
  RawStream.RawStreamSSRPlugin,
  // ReadableStreamNode is not exported by seroval
  web.ReadableStreamPlugin
];
exports.defaultSerovalPlugins = defaultSerovalPlugins;
//# sourceMappingURL=seroval-plugins.cjs.map
