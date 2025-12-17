// build.js
import { bunBuild } from "bun";
import { cpSync, mkdirSync } from "fs";
import { join } from "path";

// Step 1: Bundle your app entrypoint (index.js)
await Bun.build({
  entrypoints: ["index.js"],
  outdir: "cf",
  target: "node",
  splitting: false,
  minify: true,
  sourcemap: "inline"
});

// Step 2: Copy static assets from public to cf/public
const sourceDir = "public";
const targetDir = "cf/public";

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log("✅ Build completed! Files are in ./cf");
