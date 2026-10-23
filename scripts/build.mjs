import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  outfile: "dist/index.js",
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  jsx: "transform",
  logLevel: "info",
});

execSync("cp manifest.json dist/manifest.json", { stdio: "inherit" });
execSync(
  "cd dist && rm -f yatouch-cast.zip && zip -r yatouch-cast.zip index.js index.css manifest.json",
  { stdio: "inherit" }
);
console.log("built dist/yatouch-cast.zip");
