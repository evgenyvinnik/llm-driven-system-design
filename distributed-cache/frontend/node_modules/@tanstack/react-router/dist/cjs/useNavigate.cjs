"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const React = require("react");
const utils = require("./utils.cjs");
const useRouter = require("./useRouter.cjs");
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
function useNavigate(_defaultOpts) {
  const router = useRouter.useRouter();
  return React__namespace.useCallback(
    (options) => {
      return router.navigate({
        ...options,
        from: options.from ?? _defaultOpts?.from
      });
    },
    [_defaultOpts?.from, router]
  );
}
function Navigate(props) {
  const router = useRouter.useRouter();
  const navigate = useNavigate();
  const previousPropsRef = React__namespace.useRef(null);
  utils.useLayoutEffect(() => {
    if (previousPropsRef.current !== props) {
      navigate(props);
      previousPropsRef.current = props;
    }
  }, [router, props, navigate]);
  return null;
}
exports.Navigate = Navigate;
exports.useNavigate = useNavigate;
//# sourceMappingURL=useNavigate.cjs.map
