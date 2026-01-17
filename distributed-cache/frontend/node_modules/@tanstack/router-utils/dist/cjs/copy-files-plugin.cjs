"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const promises = require("node:fs/promises");
const pathe = require("pathe");
const tinyglobby = require("tinyglobby");
function copyFilesPlugin({
  fromDir,
  toDir,
  pattern = "**"
}) {
  return {
    name: "copy-files",
    async writeBundle() {
      const entries = await tinyglobby.glob(pattern, { cwd: fromDir });
      if (entries.length === 0) {
        throw new Error(
          `No files found matching pattern "${pattern}" in directory "${fromDir}"`
        );
      }
      for (const entry of entries) {
        const srcPath = pathe.join(fromDir, entry);
        const destPath = pathe.join(toDir, entry);
        await promises.mkdir(pathe.dirname(destPath), { recursive: true });
        await promises.copyFile(srcPath, destPath);
      }
    }
  };
}
exports.copyFilesPlugin = copyFilesPlugin;
//# sourceMappingURL=copy-files-plugin.cjs.map
