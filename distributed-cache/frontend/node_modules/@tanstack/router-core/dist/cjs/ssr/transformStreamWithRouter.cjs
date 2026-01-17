"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const web = require("node:stream/web");
const node_stream = require("node:stream");
const constants = require("./constants.cjs");
function transformReadableStreamWithRouter(router, routerStream) {
  return transformStreamWithRouter(router, routerStream);
}
function transformPipeableStreamWithRouter(router, routerStream) {
  return node_stream.Readable.fromWeb(
    transformStreamWithRouter(router, node_stream.Readable.toWeb(routerStream))
  );
}
const BODY_END_TAG = "</body>";
const HTML_END_TAG = "</html>";
const MIN_CLOSING_TAG_LENGTH = 4;
const DEFAULT_SERIALIZATION_TIMEOUT_MS = 6e4;
const DEFAULT_LIFETIME_TIMEOUT_MS = 6e4;
const textEncoder = new TextEncoder();
function findLastClosingTagEnd(str) {
  const len = str.length;
  if (len < MIN_CLOSING_TAG_LENGTH) return -1;
  let i = len - 1;
  while (i >= MIN_CLOSING_TAG_LENGTH - 1) {
    if (str.charCodeAt(i) === 62) {
      let j = i - 1;
      while (j >= 1) {
        const code = str.charCodeAt(j);
        if (code >= 97 && code <= 122 || // a-z
        code >= 65 && code <= 90 || // A-Z
        code >= 48 && code <= 57 || // 0-9
        code === 95 || // _
        code === 58 || // :
        code === 46 || // .
        code === 45) {
          j--;
        } else {
          break;
        }
      }
      const tagNameStart = j + 1;
      if (tagNameStart < i) {
        const startCode = str.charCodeAt(tagNameStart);
        if (startCode >= 97 && startCode <= 122 || startCode >= 65 && startCode <= 90) {
          if (j >= 1 && str.charCodeAt(j) === 47 && str.charCodeAt(j - 1) === 60) {
            return i + 1;
          }
        }
      }
    }
    i--;
  }
  return -1;
}
function transformStreamWithRouter(router, appStream, opts) {
  let stopListeningToInjectedHtml;
  let stopListeningToSerializationFinished;
  let serializationTimeoutHandle;
  let lifetimeTimeoutHandle;
  let cleanedUp = false;
  let controller;
  let isStreamClosed = false;
  const serializationAlreadyFinished = router.serverSsr?.isSerializationFinished() ?? false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      stopListeningToInjectedHtml?.();
      stopListeningToSerializationFinished?.();
    } catch (e) {
    }
    stopListeningToInjectedHtml = void 0;
    stopListeningToSerializationFinished = void 0;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    if (lifetimeTimeoutHandle !== void 0) {
      clearTimeout(lifetimeTimeoutHandle);
      lifetimeTimeoutHandle = void 0;
    }
    pendingRouterHtmlParts = [];
    leftover = "";
    pendingClosingTags = "";
    router.serverSsr?.cleanup();
  }
  const textDecoder = new TextDecoder();
  function safeEnqueue(chunk) {
    if (isStreamClosed) return;
    if (typeof chunk === "string") {
      controller.enqueue(textEncoder.encode(chunk));
    } else {
      controller.enqueue(chunk);
    }
  }
  function safeClose() {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.close();
    } catch {
    }
  }
  function safeError(error) {
    if (isStreamClosed) return;
    isStreamClosed = true;
    try {
      controller.error(error);
    } catch {
    }
  }
  const stream = new web.ReadableStream({
    start(c) {
      controller = c;
    },
    cancel() {
      isStreamClosed = true;
      cleanup();
    }
  });
  let isAppRendering = true;
  let streamBarrierLifted = false;
  let leftover = "";
  let pendingClosingTags = "";
  let serializationFinished = serializationAlreadyFinished;
  let pendingRouterHtmlParts = [];
  const bufferedHtml = router.serverSsr?.takeBufferedHtml();
  if (bufferedHtml) {
    pendingRouterHtmlParts.push(bufferedHtml);
  }
  function flushPendingRouterHtml() {
    if (pendingRouterHtmlParts.length > 0) {
      safeEnqueue(pendingRouterHtmlParts.join(""));
      pendingRouterHtmlParts = [];
    }
  }
  function tryFinish() {
    if (isAppRendering || !serializationFinished) return;
    if (cleanedUp || isStreamClosed) return;
    if (serializationTimeoutHandle !== void 0) {
      clearTimeout(serializationTimeoutHandle);
      serializationTimeoutHandle = void 0;
    }
    const decoderRemainder = textDecoder.decode();
    if (leftover) safeEnqueue(leftover);
    if (decoderRemainder) safeEnqueue(decoderRemainder);
    flushPendingRouterHtml();
    if (pendingClosingTags) safeEnqueue(pendingClosingTags);
    safeClose();
    cleanup();
  }
  const lifetimeMs = opts?.lifetimeMs ?? DEFAULT_LIFETIME_TIMEOUT_MS;
  lifetimeTimeoutHandle = setTimeout(() => {
    if (!cleanedUp && !isStreamClosed) {
      console.warn(
        `SSR stream transform exceeded maximum lifetime (${lifetimeMs}ms), forcing cleanup`
      );
      safeError(new Error("Stream lifetime exceeded"));
      cleanup();
    }
  }, lifetimeMs);
  if (!serializationAlreadyFinished) {
    stopListeningToInjectedHtml = router.subscribe("onInjectedHtml", () => {
      if (cleanedUp || isStreamClosed) return;
      const html = router.serverSsr?.takeBufferedHtml();
      if (!html) return;
      if (isAppRendering) {
        pendingRouterHtmlParts.push(html);
      } else {
        safeEnqueue(html);
      }
    });
    stopListeningToSerializationFinished = router.subscribe(
      "onSerializationFinished",
      () => {
        serializationFinished = true;
        tryFinish();
      }
    );
  }
  (async () => {
    const reader = appStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (cleanedUp || isStreamClosed) return;
        const text = value instanceof Uint8Array ? textDecoder.decode(value, { stream: true }) : String(value);
        const chunkString = leftover + text;
        if (!streamBarrierLifted) {
          if (chunkString.includes(constants.TSR_SCRIPT_BARRIER_ID)) {
            streamBarrierLifted = true;
            router.serverSsr?.liftScriptBarrier();
          }
        }
        const bodyEndIndex = chunkString.indexOf(BODY_END_TAG);
        const htmlEndIndex = chunkString.indexOf(HTML_END_TAG);
        if (bodyEndIndex !== -1 && htmlEndIndex !== -1 && bodyEndIndex < htmlEndIndex) {
          pendingClosingTags = chunkString.slice(bodyEndIndex);
          safeEnqueue(chunkString.slice(0, bodyEndIndex));
          flushPendingRouterHtml();
          leftover = "";
          continue;
        }
        const lastClosingTagEnd = findLastClosingTagEnd(chunkString);
        if (lastClosingTagEnd > 0) {
          safeEnqueue(chunkString.slice(0, lastClosingTagEnd));
          flushPendingRouterHtml();
          leftover = chunkString.slice(lastClosingTagEnd);
        } else {
          leftover = chunkString;
        }
      }
      if (cleanedUp || isStreamClosed) return;
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      if (serializationFinished) {
        tryFinish();
      } else {
        const timeoutMs = opts?.timeoutMs ?? DEFAULT_SERIALIZATION_TIMEOUT_MS;
        serializationTimeoutHandle = setTimeout(() => {
          if (!cleanedUp && !isStreamClosed) {
            console.error("Serialization timeout after app render finished");
            safeError(
              new Error("Serialization timeout after app render finished")
            );
            cleanup();
          }
        }, timeoutMs);
      }
    } catch (error) {
      if (cleanedUp) return;
      console.error("Error reading appStream:", error);
      isAppRendering = false;
      router.serverSsr?.setRenderFinished();
      safeError(error);
      cleanup();
    } finally {
      reader.releaseLock();
    }
  })().catch((error) => {
    if (cleanedUp) return;
    console.error("Error in stream transform:", error);
    safeError(error);
    cleanup();
  });
  return stream;
}
exports.transformPipeableStreamWithRouter = transformPipeableStreamWithRouter;
exports.transformReadableStreamWithRouter = transformReadableStreamWithRouter;
exports.transformStreamWithRouter = transformStreamWithRouter;
//# sourceMappingURL=transformStreamWithRouter.cjs.map
