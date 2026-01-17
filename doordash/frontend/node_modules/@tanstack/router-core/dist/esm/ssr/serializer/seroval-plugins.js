import { ReadableStreamPlugin } from "seroval-plugins/web";
import { ShallowErrorPlugin } from "./ShallowErrorPlugin.js";
import { RawStreamSSRPlugin } from "./RawStream.js";
const defaultSerovalPlugins = [
  ShallowErrorPlugin,
  // RawStreamSSRPlugin must come before ReadableStreamPlugin to match first
  RawStreamSSRPlugin,
  // ReadableStreamNode is not exported by seroval
  ReadableStreamPlugin
];
export {
  defaultSerovalPlugins
};
//# sourceMappingURL=seroval-plugins.js.map
