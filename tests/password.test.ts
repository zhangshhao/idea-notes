import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/app";
import { hashPassword, verifyPassword } from "../server/password";

test("password hashes use distinct salts and reject wrong passwords", async () => {
  const password = "testing-long-password-123";
  const one = await hashPassword(password),
    two = await hashPassword(password);
  assert.notEqual(one, two);
  assert.equal(one.includes(password), false);
  assert.equal(await verifyPassword(password, one), true);
  assert.equal(await verifyPassword("incorrect-password", one), false);
  assert.equal(await verifyPassword(password, undefined), false);
});

test("production password auth disables OTP, scopes secure sessions, reserves admin, rotates passwords and reauthenticates deletion", async () => {
  const service = createApp({
    database: ":memory:",
    production: true,
    origin: "https://example.com",
    cookiePath: "/idea-notes/",
    authMode: "password",
    adminEmails: ["admin"],
    ai: {
      mode: "demo",
      baseURL: "",
      apiKey: "",
      quickModel: "",
      deepModel: "",
      provider: "",
      policyURL: "",
    },
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  async function call(path: string, body?: unknown, cookie = "") {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Idea-Client": "1",
        Origin: "https://example.com",
        Cookie: cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie") || "",
    };
  }
  const password = "test-password-at-least-12";
  const body = { account: "alice", password, accepted: true };
  try {
    assert.equal((await call("/config")).data.authMode, "password");
    assert.equal(
      (await call("/auth/code", { email: "any@example.com" })).status,
      404,
    );
    assert.equal(
      (
        await call("/auth/login", {
          email: "any@example.com",
          code: "123456",
          accepted: true,
        })
      ).status,
      404,
    );
    assert.equal(
      (await call("/auth/password/register", { ...body, account: "admin" }))
        .status,
      409,
    );
    assert.equal(
      (await call("/auth/password/register", { ...body, password: "short" }))
        .status,
      400,
    );
    const registered = await call("/auth/password/register", {
      ...body,
      account: "ALICE",
    });
    assert.equal(registered.status, 200);
    assert.match(registered.cookie, /HttpOnly/);
    assert.match(registered.cookie, /Secure/);
    assert.match(registered.cookie, /Path=\/idea-notes\//);
    assert.match(registered.cookie, /SameSite=Strict/);
    const cookie = registered.cookie.split(";")[0];
    assert.equal(
      (await call("/me", undefined, cookie)).data.user.email,
      "alice",
    );
    assert.equal((await call("/admin", undefined, cookie)).status, 403);
    const stored = service.db
      .prepare("SELECT password_hash FROM password_credentials")
      .get()!;
    assert.equal(String(stored.password_hash).includes(password), false);
    assert.equal((await call("/auth/password/register", body)).status, 409);
    const bad = await call("/auth/password/login", {
      ...body,
      password: "wrong-long-password",
    });
    const missing = await call("/auth/password/login", {
      ...body,
      account: "nobody",
    });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.data, missing.data);
    const second = await call("/auth/password/login", body);
    assert.equal(second.status, 200);
    assert.equal(
      (
        await call(
          "/auth/password/change",
          {
            currentPassword: "wrong-long-password",
            newPassword: "new-long-password-456",
          },
          cookie,
        )
      ).status,
      401,
    );
    const changed = await call(
      "/auth/password/change",
      { currentPassword: password, newPassword: "new-long-password-456" },
      cookie,
    );
    assert.equal(changed.status, 200);
    assert.equal((await call("/me", undefined, cookie)).data.user, null);
    assert.equal(
      (await call("/me", undefined, second.cookie.split(";")[0])).data.user,
      null,
    );
    assert.equal((await call("/auth/password/login", body)).status, 401);
    const current = changed.cookie.split(";")[0];
    assert.equal(
      (await call("/account/delete", { password }, current)).status,
      401,
    );
    const deleted = await call(
      "/account/delete",
      { password: "new-long-password-456" },
      current,
    );
    assert.equal(deleted.status, 200);
    assert.match(deleted.cookie, /Path=\/idea-notes\//);
    assert.equal(
      service.db.prepare("SELECT count(*) n FROM password_credentials").get()!
        .n,
      0,
    );
    assert.equal((await call("/me", undefined, current)).data.user, null);
    // A separate account reaches the per-account limit even across fresh login attempts.
    for (let i = 0; i < 15; i++)
      assert.equal(
        (await call("/auth/password/login", { ...body, account: "limited" }))
          .status,
        401,
      );
    assert.equal(
      (await call("/auth/password/login", { ...body, account: "limited" }))
        .status,
      429,
    );
  } finally {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.db.close();
  }
});
