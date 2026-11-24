import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const originalWatch = fs.watch.bind(fs);
fs.watch = (...args) => {
  const watcher = originalWatch(...args);
  watcher.on("error", (error) => {
    console.warn(`File watching stopped (${error.code ?? error.message}); keep this preview running and reload the page manually after edits.`);
    watcher.close();
  });
  return watcher;
};

const require = createRequire(import.meta.url);
const sdkEntry = path.resolve(path.dirname(require.resolve("trek-plugin-sdk")), "../cli/dev.js");
const { runDev } = await import(pathToFileURL(sdkEntry).href);
await runDev(process.cwd(), { port: Number(process.env.PORT ?? 4317) });
