import * as React from "react";
import { useLayoutEffect } from "./utils.js";
import { useRouter } from "./useRouter.js";
function useNavigate(_defaultOpts) {
  const router = useRouter();
  return React.useCallback(
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
  const router = useRouter();
  const navigate = useNavigate();
  const previousPropsRef = React.useRef(null);
  useLayoutEffect(() => {
    if (previousPropsRef.current !== props) {
      navigate(props);
      previousPropsRef.current = props;
    }
  }, [router, props, navigate]);
  return null;
}
export {
  Navigate,
  useNavigate
};
//# sourceMappingURL=useNavigate.js.map
