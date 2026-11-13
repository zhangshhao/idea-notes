import { test, expect, type Page } from "@playwright/test";

test("concurrent device edits retain both versions and can save a local copy", async ({
  page,
}) => {
  const headers = { "X-Idea-Client": "1" };
  const email = `conflict-${Date.now()}@example.com`;
  const code = await (
    await page.request.post("/api/auth/code", { headers, data: { email } })
  ).json();
  await page.request.post("/api/auth/login", {
    headers,
    data: { email, code: code.developmentCode, accepted: true },
  });
  const initial = await (
    await page.request.post("/api/ideas", {
      headers,
      data: {
        id: crypto.randomUUID(),
        title: "双设备同步",
        body: "共同的初始内容",
        tags: [],
        status: "待梳理",
        favorite: false,
        archived: false,
        mode: "quick",
        summary: { current: "", known: "", questions: "" },
        actions: [],
      },
    })
  ).json();
  await page.goto("/#" + initial.id);
  await expect(page.getByLabel("原始记录")).toHaveValue("共同的初始内容");
  await page.request.put("/api/ideas/" + initial.id, {
    headers,
    data: {
      ...initial,
      body: "远端设备新增的重要内容",
      mutationId: crypto.randomUUID(),
    },
  });
  await page.getByLabel("原始记录").fill("本地设备尚未同步的重要内容");
  await expect(
    page.getByRole("heading", { name: "发现另一份更新的内容" }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.locator("dialog")).toContainText("远端设备新增的重要内容");
  await expect(page.locator("dialog")).toContainText(
    "本地设备尚未同步的重要内容",
  );
  await page.getByRole("button", { name: "本地另存为新想法" }).click();
  await expect(page.locator(".save-state")).toContainText("已保存到服务端", {
    timeout: 10000,
  });
  const records = await (await page.request.get("/api/ideas")).json();
  expect(records.total).toBe(2);
  expect(records.items.map((i: any) => i.body)).toContain(
    "远端设备新增的重要内容",
  );
  expect(records.items.map((i: any) => i.body)).toContain(
    "本地设备尚未同步的重要内容",
  );
});
async function loginUI(page: Page) {
  await page.getByRole("button", { name: "登录保存", exact: true }).click();
  await page.getByLabel("邮箱地址").fill(`ui-${Date.now()}@example.com`);
  await page.getByRole("button", { name: "获取验证码", exact: true }).click();
  await page.getByRole("button", { name: "填入", exact: true }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "登录 / 注册", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "保存刚才的灵感？" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存到此账号", exact: true }).click();
  await expect(page.getByLabel("想法标题")).toBeVisible();
}
test("guest draft → login → AI → explicit adoption → actions → export → logout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "给灵感一点生长的空间" }),
  ).toBeVisible();
  await page.screenshot({ path: "work/home-desktop.png", fullPage: true });
  await page
    .getByLabel("快速记录想法")
    .fill("想做一个社区读书交换计划，先从一个周末活动开始。");
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  await page.getByLabel("想法标题").fill("社区读书交换计划");
  await expect(page.getByLabel("原始记录")).toHaveValue(
    "想做一个社区读书交换计划，先从一个周末活动开始。",
  );
  await expect(page.getByRole("status")).toContainText("仅保存在此设备", {
    timeout: 5000,
  });
  await loginUI(page);
  await expect(page.locator(".save-state")).toContainText("已保存到服务端");
  await page.reload();
  await expect(page.getByLabel("原始记录")).toHaveValue(
    "想做一个社区读书交换计划，先从一个周末活动开始。",
  );
  await page.getByRole("tab", { name: "AI 讨论" }).click();
  await page
    .getByLabel("发送给 AI 的消息")
    .fill("怎样用最小成本验证这个想法？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "了解并同意" }).click();
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(
    page.locator(".message.assistant .message-content"),
  ).toContainText("这是本地演示回复");
  await expect(page.locator(".message-foot")).toContainText("已完成", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "整理当前想法", exact: true }).click();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看整理提议" })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole("button", { name: "查看整理提议" }).click();
  await expect(page.getByLabel("当前想法", { exact: true })).toHaveValue("");
  await page.getByRole("checkbox", { name: "用以下提议替换正式整理" }).check();
  await page
    .getByRole("checkbox", { name: "写下最需要解决的一个具体问题" })
    .check();
  await page.getByRole("button", { name: "采纳所选内容" }).click();
  await expect(page.getByLabel("当前想法", { exact: true })).toHaveValue(
    "社区读书交换计划",
  );
  await expect(page.getByLabel("行动内容")).toHaveValue(
    "写下最需要解决的一个具体问题",
  );
  await page
    .getByRole("checkbox", { name: "完成行动：写下最需要解决的一个具体问题" })
    .check();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".save-state")).toContainText("已保存到服务端");
  await page.screenshot({ path: "work/summary-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("button", { name: "导出 Markdown" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown" }).click();
  expect((await download).suggestedFilename()).toContain(".md");
  await page.getByRole("button", { name: "返回想法" }).click();
  await expect(
    page.getByRole("button", { name: "打开想法：社区读书交换计划" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "个人设置", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "给灵感一点生长的空间" }),
  ).toBeVisible();
  const cache = await page.evaluate(async () => {
    return new Promise<number>((resolve, reject) => {
      const r = indexedDB.open("idea-notes-private", 1);
      r.onerror = reject;
      r.onsuccess = () => {
        const tx = r.result.transaction("cache");
        const q = tx.objectStore("cache").count();
        q.onsuccess = () => resolve(q.result);
      };
    });
  });
  expect(cache).toBe(0);
  expect(errors).toEqual([]);
});
test("360px mobile layout keeps capture, editor, and navigation usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "给灵感一点生长的空间" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/home-mobile.png", fullPage: true });
  await page.getByLabel("快速记录想法").fill("在手机上捕捉一句灵感 🌱");
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  await expect(page.getByLabel("原始记录")).toHaveValue(
    "在手机上捕捉一句灵感 🌱",
  );
  await page.getByRole("tab", { name: "AI 讨论" }).click();
  await expect(page.getByLabel("发送给 AI 的消息")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "work/editor-mobile.png", fullPage: true });
});
test("offline local draft survives navigation and is never shown as cloud-saved", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  await page.getByLabel("原始记录").fill("离线保留的内容");
  await expect(page.locator(".save-state")).toContainText("仅保存在此设备");
  await context.setOffline(true);
  await page.getByLabel("原始记录").fill("离线保留的内容 · 新增");
  await expect(page.locator(".save-state")).toContainText("仅保存在此设备");
  await context.setOffline(false);
  await page.getByRole("button", { name: "返回想法" }).click();
  await page.getByRole("button", { name: "开始记录", exact: true }).click();
  await expect(page.getByLabel("原始记录")).toHaveValue(
    "离线保留的内容 · 新增",
  );
});
