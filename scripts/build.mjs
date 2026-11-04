import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { chdir, cwd } from "node:process";

const rootDir = cwd();
const distDir = resolve("dist");
const zipName = "ukitouch-rc.zip";
const zipPath = join(distDir, zipName);

mkdirSync(distDir, { recursive: true });

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  outfile: join(distDir, "index.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: true,
  jsx: "transform",
  logLevel: "info",
});

copyFileSync("manifest.json", join(distDir, "manifest.json"));
copyFileSync("src/index.css", join(distDir, "index.css"));

if (existsSync(zipPath)) {
  rmSync(zipPath);
}
chdir(distDir);

try {
  if (platform() === "win32") {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path 'index.js','index.css','manifest.json' -DestinationPath '${zipName}' -Force"`,
      { stdio: "inherit" }
    );
  } else {
    execSync(
      `zip -r "${zipName}" index.js index.css manifest.json`,
      { stdio: "inherit" }
    );
  }
} finally {
  chdir(rootDir);
}

console.log(`built ${zipPath}`);