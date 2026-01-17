"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const jsxRuntime = require("react/jsx-runtime");
const React = require("react");
const Asset = require("./Asset.cjs");
const useRouter = require("./useRouter.cjs");
const ClientOnly = require("./ClientOnly.cjs");
const headContentUtils = require("./headContentUtils.cjs");
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
const React__namespace = /* @__PURE__ */ _interopNamespaceDefault(React);
const DEV_STYLES_ATTR = "data-tanstack-router-dev-styles";
function HeadContent() {
  const tags = headContentUtils.useTags();
  const router = useRouter.useRouter();
  const nonce = router.options.ssr?.nonce;
  const hydrated = ClientOnly.useHydrated();
  React__namespace.useEffect(() => {
    if (hydrated) {
      document.querySelectorAll(`link[${DEV_STYLES_ATTR}]`).forEach((el) => el.remove());
    }
  }, [hydrated]);
  const filteredTags = hydrated ? tags.filter((tag) => !tag.attrs?.[DEV_STYLES_ATTR]) : tags;
  return /* @__PURE__ */ jsxRuntime.jsx(jsxRuntime.Fragment, { children: filteredTags.map((tag) => /* @__PURE__ */ React.createElement(Asset.Asset, { ...tag, key: `tsr-meta-${JSON.stringify(tag)}`, nonce })) });
}
exports.HeadContent = HeadContent;
//# sourceMappingURL=HeadContent.dev.cjs.map
