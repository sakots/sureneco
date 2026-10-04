import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";
const require = createRequire(import.meta.url);
const { build } = require("./package.json");
const electronPackage = require.resolve("electron/package.json");
const { version } = require(electronPackage);

export default {
  ...build,
  afterPack: async (context) => {
    const resources = context.packager.getResourcesDir(context.appOutDir);
    await rm(join(resources, "default_app.asar"), { force: true });
  },
  electronDist: async (context) => {
    if (
      context.platformName !== process.platform ||
      context.arch !== process.arch ||
      context.version !== version
    ) {
      return null;
    }
    return join(dirname(electronPackage), "dist");
  },
};
