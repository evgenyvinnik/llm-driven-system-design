import { jsx, Fragment } from "react/jsx-runtime";
import { createElement } from "react";
import { Asset } from "./Asset.js";
import { useRouter } from "./useRouter.js";
import { useTags } from "./headContentUtils.js";
function HeadContent() {
  const tags = useTags();
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  return /* @__PURE__ */ jsx(Fragment, { children: tags.map((tag) => /* @__PURE__ */ createElement(Asset, { ...tag, key: `tsr-meta-${JSON.stringify(tag)}`, nonce })) });
}
export {
  HeadContent
};
//# sourceMappingURL=HeadContent.js.map
