import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApp, type Config } from "../server/app";

test("real adapter streams safely and releases quota on provider errors, refusal, invalid JSON and missing usage", async () => {
  let behavior = "success";
  const received: any[] = [];
  const provider = createServer((req, res) => {
    let input = "";
    req.on("data", (c) => (input += c));
    req.on("end", () => {
      received.push(JSON.parse(input));
      res.setHeader("Content-Type", "text/event-stream");
      const event = (data: any) =>
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (behavior === "http-error") {
        res.statusCode = 503;
        res.end();
        return;
      }
      if (behavior === "slow-start") {
        res.flushHeaders();
        return;
      }
      event({
        choices: [
          {
            delta: {
              content:
                behavior === "invalid-json"
                  ? "not JSON"
                  : "真实适配器的测试片段",
            },
            finish_reason: null,
          },
        ],
      });
      if (behavior === "partial-error") {
        res.end();
        return;
      }
      if (behavior === "refusal")
        event({
          choices: [
            { delta: { refusal: "拒绝" }, finish_reason: "content_filter" },
          ],
        });
      else event({ choices: [{ delta: {}, finish_reason: "stop" }] });
      if (behavior !== "unknown-usage")
        event({
          choices: [],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 100,
            completion_tokens_details: { reasoning_tokens: 20 },
          },
        });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const config: Config = {
    database: ":memory:",
    production: false,
    origin: "http://localhost:5173",
    authMode: "development",
    adminEmails: [],
    ai: {
      mode: "openai",
      baseURL: `http://127.0.0.1:${(provider.address() as any).port}`,
      apiKey: "test-key",
      quickModel: "test-model",
      deepModel: "test-deep",
      provider: "Local fake provider",
      policyURL: "https://example.com/privacy",
    },
  };
  const service = createApp(config);
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  let cookie = "";
  const call = async (path: string, body?: any) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Idea-Client": "1",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie")!.split(";")[0];
    assert.equal(r.status, 200, JSON.stringify(data));
    return data;
  };
  try {
    const code = await call("/auth/code", { email: "provider@example.com" });
    await call("/auth/login", {
      email: "provider@example.com",
      code: code.developmentCode,
      accepted: true,
    });
    await call("/auth/ai-consent", {});
    const idea = await call("/ideas", {
      id: crypto.randomUUID(),
      title: "边界测试",
      body: "只发送这条记录",
      tags: [],
      status: "待梳理",
      favorite: false,
      archived: false,
      mode: "quick",
      summary: { current: "", known: "", questions: "" },
      actions: [],
    });
    const run = async (kind = "chat") => {
      const q = await call(`/ideas/${idea.id}/quote`, {
        prompt: "给我一点建议",
        mode: "quick",
        kind,
        outputLimit: 512,
      });
      const r = await call(`/ideas/${idea.id}/requests`, {
        id: crypto.randomUUID(),
        quoteId: q.id,
      });
      for (let n = 0; n < 100; n++) {
        const result = await call(`/requests/${r.id}`);
        if (result.state !== "running") return result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("timeout");
    };
    const success = await run();
    assert.equal(success.state, "completed");
    assert.equal(success.charged, 1);
    assert.match(success.content, /测试片段/);
    assert.equal(received[0].stream, true);
    assert.equal(received[0].model, "test-model");
    assert.equal(received[0].max_tokens, 512);
    assert.equal(received[0].messages[1].content.includes(idea.body), true);
    for (const scenario of [
      "http-error",
      "partial-error",
      "refusal",
      "invalid-json",
      "unknown-usage",
    ]) {
      behavior = scenario;
      const result = await run(
        scenario === "invalid-json" ? "summary" : "chat",
      );
      assert.equal(result.charged, 0, scenario);
      assert.equal(
        result.state,
        scenario === "unknown-usage" ? "completed" : "failed",
        scenario,
      );
      assert.equal((await call("/quota")).reserved, 0, scenario);
    }
    assert.equal((await call("/quota")).used, 1);
    // Fresh rate-limit window for independent cancellation and recovery scenarios.
    service.db.prepare("DELETE FROM auth_limits WHERE key LIKE 'ai:%'").run();
    behavior = "slow-start";
    const createPending = async () => {
      const q = await call(`/ideas/${idea.id}/quote`, {
        prompt: "取消边界测试",
        mode: "quick",
        kind: "chat",
        outputLimit: 512,
      });
      return call(`/ideas/${idea.id}/requests`, {
        id: crypto.randomUUID(),
        quoteId: q.id,
      });
    };
    const stopped = await createPending();
    await call(`/requests/${stopped.id}/stop`, {});
    for (let n = 0; n < 100; n++) {
      const status = await call(`/requests/${stopped.id}`);
      if (status.state === "stopped") {
        assert.equal(status.charged, 0);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await call(`/requests/${stopped.id}`)).state, "stopped");
    assert.equal((await call("/quota")).reserved, 0);
    const interrupted = await createPending();
    service.runner.recover();
    assert.equal((await call(`/requests/${interrupted.id}`)).state, "failed");
    assert.equal((await call("/quota")).reserved, 0);
    assert.equal((await call("/quota")).used, 1);
  } finally {
    service.close();
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => provider.close(() => resolve())),
    ]);
    service.db.close();
  }
});
