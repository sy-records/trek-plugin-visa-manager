import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
  entryPoints: ["ui/index.js"],
  outfile: "client/ui.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
});
