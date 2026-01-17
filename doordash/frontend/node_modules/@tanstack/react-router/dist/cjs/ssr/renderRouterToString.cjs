"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const ReactDOMServer = require("react-dom/server");
const renderRouterToString = async ({
  router,
  responseHeaders,
  children
}) => {
  try {
    let html = ReactDOMServer.renderToString(children);
    router.serverSsr.setRenderFinished();
    const injectedHtml = router.serverSsr.takeBufferedHtml();
    if (injectedHtml) {
      html = html.replace(`</body>`, () => `${injectedHtml}</body>`);
    }
    return new Response(`<!DOCTYPE html>${html}`, {
      status: router.state.statusCode,
      headers: responseHeaders
    });
  } catch (error) {
    console.error("Render to string error:", error);
    return new Response("Internal Server Error", {
      status: 500,
      headers: responseHeaders
    });
  } finally {
    router.serverSsr?.cleanup();
  }
};
exports.renderRouterToString = renderRouterToString;
//# sourceMappingURL=renderRouterToString.cjs.map
