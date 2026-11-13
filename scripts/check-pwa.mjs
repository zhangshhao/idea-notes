import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const base = process.env.PWA_URL || "http://127.0.0.1:3001";
await mkdir("work", { recursive: true });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () => {
    const result = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      result.push(...(await cache.keys()).map((r) => new URL(r.url).pathname));
    }
    return result;
  });
  assert(
    cached.some((path) => path.endsWith(".js")),
    "JavaScript must be precached before first offline reload",
  );
  assert(
    cached.some((path) => path.endsWith(".css")),
    "Styles must be precached",
  );
  assert(
    !cached.some((path) => path.startsWith("/api/")),
    "Private API responses must never be cached by the worker",
  );
  await page
    .getByLabel("快速记录想法")
    .fill("PWA 离线验收：这是一条本地草稿。");
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector(".save-state")
      ?.textContent?.includes("仅保存在此设备"),
  );
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  assert.equal(
    await page.getByLabel("原始记录").inputValue(),
    "PWA 离线验收：这是一条本地草稿。",
  );
  assert(
    (await page.locator(".save-state").textContent()).includes("草稿") ||
      (await page.locator(".save-state").textContent()).includes("此设备"),
  );
  await page.screenshot({ path: "work/pwa-offline.png", fullPage: true });
  await context.setOffline(false);
  const manifest = await (
    await page.request.get(base + "/manifest.webmanifest")
  ).json();
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons)
    assert.equal((await page.request.get(base + icon.src)).status(), 200);
  console.log(
    "PASS: hashed shell cache, first-visit offline reload, persisted draft, private API exclusion, manifest and icons.",
  );
  await context.close();
} finally {
  await browser.close();
}
