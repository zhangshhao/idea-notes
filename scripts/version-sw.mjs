import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const html = await readFile("dist/index.html", "utf8");
const version = createHash("sha256").update(html).digest("hex").slice(0, 12);
const assets = (await readdir("dist/assets"))
  .filter((name) => /\.(js|css)$/.test(name))
  .map((name) => "/assets/" + name);
const files = [
  "/",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  ...assets,
];
const sw = (await readFile("public/sw.js", "utf8"))
  .replace(/["']idea-shell-v1["']/, `'idea-shell-${version}'`)
  .replace(
    /const PRECACHE = [\s\S]*?;/,
    `const PRECACHE = ${JSON.stringify(files)};`,
  );
await writeFile("dist/sw.js", sw);
console.log(`PWA shell ${version}: ${files.length} assets precached.`);
