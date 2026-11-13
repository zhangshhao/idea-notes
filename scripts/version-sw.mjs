import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = process.env.APP_BASE_PATH || "/";
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base))
  throw new Error("Invalid APP_BASE_PATH");
const html = await readFile("dist/index.html", "utf8");
const version = createHash("sha256").update(html).digest("hex").slice(0, 12);
const assets = (await readdir("dist/assets"))
  .filter((name) => /\.(js|css)$/.test(name))
  .map((name) => base + "assets/" + name);
const files = [
  base,
  base + "icon.svg",
  base + "icon-192.png",
  base + "icon-512.png",
  base + "manifest.webmanifest",
  ...assets,
];
const sw = (await readFile("public/sw.js", "utf8"))
  .replace(/["']idea-shell-v1["']/, `'idea-shell-${base}-${version}'`)
  .replace(
    /const PRECACHE = [\s\S]*?;/,
    `const PRECACHE = ${JSON.stringify(files)};`,
  );
await writeFile("dist/sw.js", sw);
console.log(`PWA shell ${version}: ${files.length} assets precached.`);

const manifest = JSON.parse(
  await readFile("public/manifest.webmanifest", "utf8"),
);
manifest.id = manifest.start_url = manifest.scope = base;
manifest.icons = manifest.icons.map((icon) => ({
  ...icon,
  src: base + icon.src.replace(/^\//, ""),
}));
await writeFile("dist/manifest.webmanifest", JSON.stringify(manifest));
