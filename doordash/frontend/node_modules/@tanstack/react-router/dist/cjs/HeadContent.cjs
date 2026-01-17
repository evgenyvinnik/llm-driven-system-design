"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const jsxRuntime = require("react/jsx-runtime");
const React = require("react");
const Asset = require("./Asset.cjs");
const useRouter = require("./useRouter.cjs");
const headContentUtils = require("./headContentUtils.cjs");
function HeadContent() {
  const tags = headContentUtils.useTags();
  const router = useRouter.useRouter();
  const nonce = router.options.ssr?.nonce;
  return /* @__PURE__ */ jsxRuntime.jsx(jsxRuntime.Fragment, { children: tags.map((tag) => /* @__PURE__ */ React.createElement(Asset.Asset, { ...tag, key: `tsr-meta-${JSON.stringify(tag)}`, nonce })) });
}
exports.HeadContent = HeadContent;
//# sourceMappingURL=HeadContent.cjs.map
