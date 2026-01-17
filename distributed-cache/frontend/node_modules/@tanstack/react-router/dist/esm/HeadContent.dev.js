import { jsx, Fragment } from "react/jsx-runtime";
import * as React from "react";
import { createElement } from "react";
import { Asset } from "./Asset.js";
import { useRouter } from "./useRouter.js";
import { useHydrated } from "./ClientOnly.js";
import { useTags } from "./headContentUtils.js";
const DEV_STYLES_ATTR = "data-tanstack-router-dev-styles";
function HeadContent() {
  const tags = useTags();
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const hydrated = useHydrated();
  React.useEffect(() => {
    if (hydrated) {
      document.querySelectorAll(`link[${DEV_STYLES_ATTR}]`).forEach((el) => el.remove());
    }
  }, [hydrated]);
  const filteredTags = hydrated ? tags.filter((tag) => !tag.attrs?.[DEV_STYLES_ATTR]) : tags;
  return /* @__PURE__ */ jsx(Fragment, { children: filteredTags.map((tag) => /* @__PURE__ */ createElement(Asset, { ...tag, key: `tsr-meta-${JSON.stringify(tag)}`, nonce })) });
}
export {
  HeadContent
};
//# sourceMappingURL=HeadContent.dev.js.map
