import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp, type Config } from "../server/app";
import { monthBounds, points } from "../server/domain";
import JSZip from "jszip";

const config: Config = {
  database: ":memory:",
  production: false,
  origin: "http://localhost:5173",
  authMode: "development",
  adminEmails: ["admin@example.com"],
  dailyLimit: 999,
  ai: {
    mode: "demo",
    baseURL: "",
    apiKey: "",
    quickModel: "demo",
    deepModel: "demo-deep",
    provider: "demo",
    policyURL: "",
  },
};
let app: ReturnType<typeof createApp>;
let server: Server;
let base = "";
let alice = "";
let bob = "";
let idea: any;
async function request(path: string, cookie = "", body?: any, method?: string) {
  const response = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      "X-Idea-Client": "1",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return {
    status: response.status,
    data,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
  };
}
async function login(email: string) {
  const code = await request("/auth/code", "", { email });
  assert.equal(code.status, 200);
  const result = await request("/auth/login", "", {
    email,
    code: code.data.developmentCode,
    accepted: true,
  });
  assert.equal(result.status, 200);
  return result.cookie;
}
function note(body = "想给社区做一份每周阅读清单") {
  return {
    id: crypto.randomUUID(),
    title: "社区阅读清单",
    body,
    tags: ["阅读"],
    status: "待梳理",
    favorite: false,
    archived: false,
    mode: "quick",
    summary: { current: "", known: "", questions: "" },
    actions: [],
  };
}
async function estimate(id: string, cookie = alice, kind = "chat") {
  return request(`/ideas/${id}/quote`, cookie, {
    prompt: "可以先验证什么？",
    mode: "quick",
    kind,
    outputLimit: 512,
  });
}
async function completed(id: string, cookie = alice) {
  for (let n = 0; n < 120; n++) {
    const r = await request(`/requests/${id}`, cookie);
    if (r.data.state !== "running") return r.data;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("request did not finish");
}
before(async () => {
  app = createApp(config);
  server = app.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  alice = await login("alice@example.com");
  bob = await login("bob@example.com");
});
after(async () => {
  app.close();
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  app.db.close();
});
test("development shortcuts cannot be used as production authentication", () => {
  assert.throws(() => createApp({ ...config, production: true }), /SMTP/);
});
test("timezone boundaries and token example follow the product rule", () => {
  assert.equal(points(2000, 500), 4);
  assert.equal(points(2000, 2048), 11);
  assert.equal(points(2000, 500, "deep"), 16);
  assert.deepEqual(monthBounds(new Date("2026-12-31T16:00:00Z")), {
    starts: "2026-12-31T16:00:00.000Z",
    ends: "2027-01-31T16:00:00.000Z",
  });
});
test("authentication, CSRF and administrative access are enforced", async () => {
  assert.equal((await request("/ideas")).status, 401);
  assert.equal((await request("/admin")).status, 401);
  assert.equal((await request("/admin", bob)).status, 403);
  const r = await fetch(base + "/ideas", {
    method: "POST",
    headers: { Cookie: alice, "Content-Type": "application/json" },
    body: JSON.stringify(note()),
  });
  assert.equal(r.status, 403);
});
test("validates blank and oversized Unicode bodies without creating notes", async () => {
  assert.equal((await request("/ideas", alice, note(" \n "))).status, 400);
  assert.equal(
    (await request("/ideas", alice, note("字".repeat(20001)))).status,
    400,
  );
  assert.equal((await request("/ideas", alice)).data.total, 0);
});
test("creates idempotently and preserves Unicode exactly", async () => {
  const input = note("第一行 🌱\n\n保留中文与换行。");
  const a = await request("/ideas", alice, input);
  assert.equal(a.status, 200);
  const b = await request("/ideas", alice, input);
  assert.equal(a.data.id, b.data.id);
  assert.equal(b.data.body, input.body);
  assert.equal((await request("/ideas", alice)).data.total, 1);
  idea = a.data;
});
test("cannot read, update, export, or delete another account’s idea", async () => {
  assert.equal((await request(`/ideas/${idea.id}`, bob)).status, 404);
  assert.equal(
    (
      await request(
        `/ideas/${idea.id}`,
        bob,
        { ...idea, mutationId: crypto.randomUUID() },
        "PUT",
      )
    ).status,
    404,
  );
  assert.equal((await request(`/ideas/${idea.id}/export`, bob)).status, 404);
  assert.equal(
    (await request(`/ideas/${idea.id}/trash`, bob, { version: idea.version }))
      .status,
    404,
  );
});
test("updates use optimistic versions and stable mutation IDs", async () => {
  const change = {
    ...idea,
    title: "更新后的标题",
    mutationId: crypto.randomUUID(),
  };
  const updated = await request(`/ideas/${idea.id}`, alice, change, "PUT");
  assert.equal(updated.status, 200);
  assert.equal(updated.data.version, 2);
  const retry = await request(`/ideas/${idea.id}`, alice, change, "PUT");
  assert.equal(retry.data.version, 2);
  const stale = await request(
    `/ideas/${idea.id}`,
    alice,
    { ...idea, mutationId: crypto.randomUUID() },
    "PUT",
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "VERSION_CONFLICT");
  assert.equal(stale.data.details.title, "更新后的标题");
  idea = updated.data;
});
test("free accounts cannot invoke deep mode or bypass AI consent", async () => {
  const before = app.db.prepare("SELECT COUNT(*) n FROM requests").get() as any;
  const noConsent = await estimate(idea.id);
  assert.equal(noConsent.data.code, "AI_CONSENT");
  await request("/auth/ai-consent", alice, {});
  const deep = await request(`/ideas/${idea.id}/quote`, alice, {
    prompt: "思考",
    mode: "deep",
    kind: "chat",
    outputLimit: 512,
  });
  assert.equal(deep.status, 403);
  assert.equal(
    (app.db.prepare("SELECT COUNT(*) n FROM requests").get() as any).n,
    before.n,
  );
});
test("single active task, request deduplication, and exactly-once quota settlement", async () => {
  const q = await estimate(idea.id);
  assert.equal(q.status, 200);
  const id = crypto.randomUUID();
  const sent = await request(`/ideas/${idea.id}/requests`, alice, {
    id,
    quoteId: q.data.id,
  });
  assert.equal(sent.status, 200);
  const duplicate = await request(`/ideas/${idea.id}/requests`, alice, {
    id,
    quoteId: q.data.id,
  });
  assert.equal(duplicate.data.reused, true);
  const concurrent = await request(`/ideas/${idea.id}/requests`, alice, {
    id: crypto.randomUUID(),
    quoteId: q.data.id,
  });
  assert.equal(concurrent.data.code, "TASK_RUNNING");
  const active = await request("/quota", alice);
  assert.equal(active.data.reserved, q.data.maximum);
  const done = await completed(id);
  assert.equal(done.state, "completed");
  assert.ok(done.charged > 0);
  const ledger = (await request("/ledger", alice)).data.filter(
    (r: any) => r.requestId === id,
  );
  assert.equal(ledger.filter((l: any) => l.kind === "consume").length, 1);
  assert.equal(
    ledger.find((l: any) => l.kind === "release").amount + done.charged,
    q.data.maximum,
  );
  app.runner.finish(id, "completed", { usage: { input: 2000, output: 500 } });
  assert.equal((await request("/quota", alice)).data.used, done.charged);
  assert.equal((await request("/quota", alice)).data.reserved, 0);
  assert.equal(
    (await request(`/ideas/${idea.id}/messages`, alice)).data.length,
    2,
  );
});
test("other ideas and users cannot see messages or requests", async () => {
  const b = await request("/ideas", alice, note("仅属于另一个想法的内容"));
  const msgs = await request(`/ideas/${b.data.id}/messages`, alice);
  assert.deepEqual(msgs.data, []);
  const r = app.db.prepare("SELECT id FROM requests LIMIT 1").get() as any;
  assert.equal((await request(`/requests/${r.id}`, bob)).status, 404);
  assert.equal((await request(`/ideas/${idea.id}/messages`, bob)).status, 404);
});
test("invalid or changed quotes never call a provider", async () => {
  const q = await estimate(idea.id);
  const updated = await request(
    `/ideas/${idea.id}`,
    alice,
    { ...idea, body: idea.body + "补充", mutationId: crypto.randomUUID() },
    "PUT",
  );
  idea = updated.data;
  const sent = await request(`/ideas/${idea.id}/requests`, alice, {
    id: crypto.randomUUID(),
    quoteId: q.data.id,
  });
  assert.equal(sent.data.code, "VERSION_CONFLICT");
});
test("AI proposals require explicit selection and adoption is idempotent", async () => {
  const q = await estimate(idea.id, alice, "summary");
  const id = crypto.randomUUID();
  await request(`/ideas/${idea.id}/requests`, alice, {
    id,
    quoteId: q.data.id,
  });
  assert.equal((await completed(id)).state, "completed");
  const old = (await request(`/ideas/${idea.id}`, alice)).data;
  assert.equal(old.summary.current, "");
  assert.equal(old.actions.length, 0);
  const adoption = {
    requestId: id,
    version: old.version,
    summary: true,
    actions: [0, 0, 2],
  };
  const a = await request(`/ideas/${idea.id}/adopt`, alice, adoption);
  assert.equal(a.status, 200);
  assert.equal(a.data.actions.length, 2);
  assert.ok(a.data.summary.current);
  const b = await request(`/ideas/${idea.id}/adopt`, alice, adoption);
  assert.equal(b.data.version, a.data.version);
  assert.equal(b.data.actions.length, 2);
  idea = a.data;
});
test("proposals cannot overwrite a version modified after generation", async () => {
  const q = await estimate(idea.id, alice, "summary");
  const id = crypto.randomUUID();
  await request(`/ideas/${idea.id}/requests`, alice, {
    id,
    quoteId: q.data.id,
  });
  await completed(id);
  idea = (
    await request(
      `/ideas/${idea.id}`,
      alice,
      { ...idea, title: "另一设备已编辑", mutationId: crypto.randomUUID() },
      "PUT",
    )
  ).data;
  const a = await request(`/ideas/${idea.id}/adopt`, alice, {
    requestId: id,
    version: idea.version,
    summary: true,
    actions: [],
  });
  assert.equal(a.data.code, "STALE_PROPOSAL");
  assert.equal(
    (await request(`/ideas/${idea.id}`, alice)).data.title,
    "另一设备已编辑",
  );
});
test("trashing blocks generation and stale edits, restore keeps associations", async () => {
  const removed = await request(`/ideas/${idea.id}/trash`, alice, {
    version: idea.version,
  });
  assert.equal(removed.status, 200);
  assert.equal((await estimate(idea.id)).data.code, "DELETED");
  assert.equal(
    (
      await request(
        `/ideas/${idea.id}`,
        alice,
        { ...idea, mutationId: crypto.randomUUID() },
        "PUT",
      )
    ).data.code,
    "DELETED",
  );
  assert.equal((await request("/ideas?view=trash", alice)).data.total, 1);
  const restore = await request(`/ideas/${idea.id}/trash`, alice, {
    version: removed.data.version,
    restore: true,
  });
  idea = restore.data;
  assert.equal(idea.actions.length, 2);
  assert.ok(
    (await request(`/ideas/${idea.id}/messages`, alice)).data.length > 0,
  );
});
test("ZIP export is complete and account-scoped", async () => {
  await request("/ideas", bob, note("Bob private note"));
  const response = await fetch(base + "/export?chat=true", {
    headers: { Cookie: alice },
  });
  assert.equal(response.status, 200);
  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const data = JSON.parse(await zip.file("data.json")!.async("string"));
  assert.equal(data.formatVersion, 1);
  assert.equal(data.ideas.length, 2);
  assert.ok(!JSON.stringify(data).includes("Bob private note"));
  assert.ok(data.ideas.find((i: any) => i.id === idea.id).messages.length > 0);
});
test("insufficient quota does not create a task or message", async () => {
  await request("/auth/ai-consent", bob, {});
  const b = (await request("/ideas", bob, note())).data;
  const q = await estimate(b.id, bob);
  const user = (await request("/me", bob)).data.user.id;
  app.db.prepare("UPDATE periods SET total=0 WHERE user_id=?").run(user);
  const r = await request(`/ideas/${b.id}/requests`, bob, {
    id: crypto.randomUUID(),
    quoteId: q.data.id,
  });
  assert.equal(r.data.code, "QUOTA_EXCEEDED");
  assert.equal((await request(`/ideas/${b.id}/messages`, bob)).data.length, 0);
});
test("permanent deletion purges private request content but retains minimal accounting", async () => {
  const removed = await request(`/ideas/${idea.id}/trash`, alice, {
    version: idea.version,
  });
  assert.equal(removed.status, 200);
  assert.equal(
    (await request(`/ideas/${idea.id}`, alice, { confirm: true }, "DELETE"))
      .status,
    200,
  );
  assert.equal((await request(`/ideas/${idea.id}`, alice)).status, 404);
  const requests = app.db
    .prepare("SELECT data FROM requests WHERE idea_id IS NULL")
    .all() as any[];
  assert.ok(requests.length > 0);
  for (const r of requests) {
    const data = JSON.parse(r.data);
    assert.equal(data.context, undefined);
    assert.equal(data.content, undefined);
    assert.equal(data.ideaBody, undefined);
  }
});
test("logout revokes the session on the server", async () => {
  await request("/auth/logout", bob, {});
  assert.equal((await request("/ideas", bob)).status, 401);
});

test("stopping a partial demo response settles once and releases the remainder", async () => {
  const another = (await request("/ideas", alice, note("停止生成的边界验证")))
    .data;
  const q = await estimate(another.id);
  const id = crypto.randomUUID();
  await request(`/ideas/${another.id}/requests`, alice, {
    id,
    quoteId: q.data.id,
  });
  await request(`/requests/${id}/stop`, alice, {});
  const result = await completed(id);
  assert.equal(result.state, "stopped");
  assert.ok(result.content.length > 0);
  assert.ok(result.charged > 0 && result.charged <= q.data.maximum);
  await request(`/requests/${id}/stop`, alice, {});
  const entries = (await request("/ledger", alice)).data.filter(
    (r: any) => r.requestId === id,
  );
  assert.equal(entries.filter((r: any) => r.kind === "consume").length, 1);
  assert.equal(
    entries.find((r: any) => r.kind === "release").amount + result.charged,
    q.data.maximum,
  );
  assert.equal((await request("/quota", alice)).data.reserved, 0);
});
