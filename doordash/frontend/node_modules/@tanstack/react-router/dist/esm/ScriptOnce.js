import { jsx } from "react/jsx-runtime";
import { useRouter } from "./useRouter.js";
function ScriptOnce({ children }) {
  const router = useRouter();
  if (!router.isServer) {
    return null;
  }
  return /* @__PURE__ */ jsx(
    "script",
    {
      nonce: router.options.ssr?.nonce,
      dangerouslySetInnerHTML: {
        __html: children + ";document.currentScript.remove()"
      }
    }
  );
}
export {
  ScriptOnce
};
//# sourceMappingURL=ScriptOnce.js.map
