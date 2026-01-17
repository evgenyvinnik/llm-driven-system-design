"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const seroval = require("seroval");
const ShallowErrorPlugin = /* @__PURE__ */ seroval.createPlugin({
  tag: "$TSR/Error",
  test(value) {
    return value instanceof Error;
  },
  parse: {
    sync(value, ctx) {
      return {
        message: ctx.parse(value.message)
      };
    },
    async async(value, ctx) {
      return {
        message: await ctx.parse(value.message)
      };
    },
    stream(value, ctx) {
      return {
        message: ctx.parse(value.message)
      };
    }
  },
  serialize(node, ctx) {
    return "new Error(" + ctx.serialize(node.message) + ")";
  },
  deserialize(node, ctx) {
    return new Error(ctx.deserialize(node.message));
  }
});
exports.ShallowErrorPlugin = ShallowErrorPlugin;
//# sourceMappingURL=ShallowErrorPlugin.cjs.map
