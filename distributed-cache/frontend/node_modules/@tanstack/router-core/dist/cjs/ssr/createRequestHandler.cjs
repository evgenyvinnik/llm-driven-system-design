"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const history = require("@tanstack/history");
const headers = require("./headers.cjs");
const ssrServer = require("./ssr-server.cjs");
function createRequestHandler({
  createRouter,
  request,
  getRouterManifest
}) {
  return async (cb) => {
    const router = createRouter();
    let cbWillCleanup = false;
    try {
      ssrServer.attachRouterServerSsrUtils({
        router,
        manifest: await getRouterManifest?.()
      });
      const url = new URL(request.url, "http://localhost");
      const origin = ssrServer.getOrigin(request);
      const href = url.href.replace(url.origin, "");
      const history$1 = history.createMemoryHistory({
        initialEntries: [href]
      });
      router.update({
        history: history$1,
        origin: router.options.origin ?? origin
      });
      await router.load();
      await router.serverSsr?.dehydrate();
      const responseHeaders = getRequestHeaders({
        router
      });
      cbWillCleanup = true;
      return cb({
        request,
        router,
        responseHeaders
      });
    } finally {
      if (!cbWillCleanup) {
        router.serverSsr?.cleanup();
      }
    }
  };
}
function getRequestHeaders(opts) {
  let headers$1 = headers.mergeHeaders(
    {
      "Content-Type": "text/html; charset=UTF-8"
    },
    ...opts.router.state.matches.map((match) => {
      return match.headers;
    })
  );
  const { redirect } = opts.router.state;
  if (redirect) {
    headers$1 = headers.mergeHeaders(headers$1, redirect.headers);
  }
  return headers$1;
}
exports.createRequestHandler = createRequestHandler;
//# sourceMappingURL=createRequestHandler.cjs.map
