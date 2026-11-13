import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase } from "../server/db";
import { createBilling } from "../server/payments/billing";
import { subscriptionBoundary } from "../server/payments/calendar";
import { quota, row, uid } from "../server/domain";
import { createApp } from "../server/app";
import { paymentFixture } from "./payment-fixture";

function setup() {
  const fixture = paymentFixture();
  const db = openDatabase(":memory:");
  const user = uid();
  db.prepare("INSERT INTO users VALUES(?,?,?,?,NULL)").run(
    user,
    "buyer@example.com",
    new Date().toISOString(),
    "test",
  );
  let clock = new Date();
  const billing = createBilling(db, { ...fixture.billing, clock: () => clock });
  const version = billing.status().plans[0].version;
  return {
    ...fixture,
    db,
    user,
    billing,
    version,
    at: (at: string) => {
      clock = new Date(at);
    },
    current: () => clock,
    checkout: (key = uid(), channel: "native" | "h5" = "native") =>
      billing.checkout(
        user,
        { key, channel, planVersion: version },
        "203.0.113.8",
      ),
  };
}
test("WeChat disabled without merchant or pricing; no fake public payment completion endpoint", async () => {
  const db = openDatabase(":memory:");
  try {
    const billing = createBilling(db);
    assert.equal(billing.status().enabled, false);
    assert.ok(billing.status().missing.includes("STANDARD_PRICE_FEN"));
    await assert.rejects(
      () =>
        billing.checkout(
          "user",
          { key: uid(), channel: "native", planVersion: "x" },
          "127.0.0.1",
        ),
      /待商户/,
    );
  } finally {
    db.close();
  }
});
test("original calendar anchor handles 31st, leap years and Shanghai midnight", () => {
  assert.equal(
    subscriptionBoundary("2028-01-31T07:45:00.000Z", 1),
    "2028-02-29T07:45:00.000Z",
  );
  assert.equal(
    subscriptionBoundary("2028-01-31T07:45:00.000Z", 2),
    "2028-03-31T07:45:00.000Z",
  );
  assert.equal(
    subscriptionBoundary("2027-01-30T16:00:00.000Z", 1),
    "2027-02-27T16:00:00.000Z",
  );
  assert.equal(
    subscriptionBoundary("2026-12-31T16:00:00.000Z", 1),
    "2027-01-31T16:00:00.000Z",
  );
});
test("outbound signatures, backend prices, Native/H5 payloads and response signatures", async () => {
  const t = setup();
  try {
    const key = uid();
    const order = await t.checkout(key);
    assert.equal(order.amount, 1234);
    assert.equal(order.status, "pending");
    assert.ok(order.paymentUrl?.startsWith("weixin://"));
    assert.equal(t.calls[0].body.amount.total, 1234);
    assert.equal(t.calls[0].body.notify_url, t.config.notifyUrl);
    assert.equal((await t.checkout(key)).id, order.id);
    assert.equal(t.calls.length, 1);
    await t.billing.close(order.id, t.user);
    const h5 = await t.checkout(uid(), "h5");
    assert.ok(h5.paymentUrl?.startsWith("https://wx.tenpay.com/"));
    assert.ok(h5.paymentUrl?.includes("redirect_url="));
    const call = t.calls.find((c) => c.path.endsWith("/h5"))!;
    assert.equal(call.body.scene_info.payer_client_ip, "203.0.113.8");
    t.setBadSignature(true);
    await assert.rejects(() => t.provider.query(h5.id), /请求未确认/);
    assert.equal(quota(t.db, t.user).plan, "free");
  } finally {
    t.db.close();
  }
});
test("expired H5 URLs are hidden and refreshed using the same merchant order", async () => {
  const t = setup();
  try {
    const key = uid();
    const original = await t.checkout(key, "h5");
    t.at(new Date(t.current().getTime() + 5 * 60000 + 1).toISOString());
    assert.equal(
      t.billing.publicOrder(t.billing.get(original.id)).paymentUrl,
      null,
    );
    const refreshed = await t.checkout(key, "h5");
    assert.equal(refreshed.id, original.id);
    assert.ok(refreshed.paymentUrl);
    assert.equal(t.transactions.size, 1);
    assert.equal(
      t.calls.filter((c) => c.path === "/v3/pay/transactions/h5").length,
      2,
    );
  } finally {
    t.db.close();
  }
});

test("timeouts reuse the same provider order, and only one pending order can exist", async () => {
  const t = setup();
  try {
    const key = uid();
    t.timeoutNextCreate();
    const order = await t.checkout(key);
    assert.equal(order.status, "unknown");
    await assert.rejects(() => t.checkout(), /待处理订单/);
    const retried = await t.checkout(key);
    assert.equal(retried.id, order.id);
    assert.equal(retried.status, "pending");
    assert.equal(t.transactions.size, 1);
    assert.equal(quota(t.db, t.user).plan, "free");
  } finally {
    t.db.close();
  }
});
test("verified encrypted callback grants once; duplicates, tampering, replay and mismatches cannot overgrant", async () => {
  const t = setup();
  try {
    const order = await t.checkout();
    const result = t.paid(order.id);
    const callback = t.notification(result);
    const forged = new Headers(callback.headers);
    forged.set("Wechatpay-Signature", "fake");
    await assert.rejects(() =>
      t.billing.notification("payment", callback.raw, forged),
    );
    assert.equal(quota(t.db, t.user).plan, "free");
    for (const patch of [
      { mchid: "another" },
      { appid: "wxwrong" },
      { amount: { total: 1, currency: "CNY" } },
      { amount: { total: 1234, currency: "USD" } },
    ]) {
      const bad = t.notification({ ...result, ...patch });
      await assert.rejects(() =>
        t.billing.notification("payment", bad.raw, bad.headers),
      );
    }
    const old = new Headers(callback.headers);
    old.set("Wechatpay-Timestamp", "1");
    await assert.rejects(() =>
      t.billing.notification("payment", callback.raw, old),
    );
    await t.billing.notification("payment", callback.raw, callback.headers);
    await t.billing.notification("payment", callback.raw, callback.headers);
    const duplicate = t.notification(result);
    await t.billing.notification("payment", duplicate.raw, duplicate.headers);
    assert.equal(quota(t.db, t.user).plan, "standard");
    assert.equal(quota(t.db, t.user).available, 2000);
    assert.equal(row(t.db, "SELECT COUNT(*) n FROM subscriptions").n, 1);
    assert.equal(
      row(
        t.db,
        "SELECT COUNT(*) n FROM ledger WHERE period_id=? AND kind='grant'",
        "paid:" + order.id,
      ).n,
      1,
    );
    const altered = t.notification(
      { ...result, amount: { total: 999, currency: "CNY" } },
      "payment",
      callback.id,
    );
    await assert.rejects(() =>
      t.billing.notification("payment", altered.raw, altered.headers),
    );
  } finally {
    t.db.close();
  }
});
test("query repairs missed callbacks, stale NOTPAY cannot remove paid benefits", async () => {
  const t = setup();
  try {
    const order = await t.checkout();
    t.paid(order.id);
    await t.billing.reconcile(order.id, true);
    assert.equal(t.billing.get(order.id).status, "paid");
    assert.equal(quota(t.db, t.user).plan, "standard");
    t.transactions.get(order.id).trade_state = "NOTPAY";
    await t.billing.reconcile(order.id, true);
    assert.equal(t.billing.get(order.id).status, "paid");
    await assert.rejects(() => t.billing.close(order.id, t.user), /不能关闭/);
  } finally {
    t.db.close();
  }
});
test("manual renewal starts next month, grants only on activation and keeps original month anchor", async () => {
  const t = setup();
  try {
    t.at("2028-01-31T07:00:00.000Z");
    const first = await t.checkout();
    let event = t.notification(t.paid(first.id));
    await t.billing.notification("payment", event.raw, event.headers);
    const q1 = quota(t.db, t.user, t.current());
    assert.equal(q1.ends, "2028-02-29T07:00:00.000Z");
    const next = await t.checkout();
    event = t.notification(t.paid(next.id));
    await t.billing.notification("payment", event.raw, event.headers);
    const q2 = quota(t.db, t.user, t.current());
    assert.equal(q2.id, q1.id);
    assert.equal(q2.available, 2000);
    assert.equal(q2.nextPeriod.endsAt, "2028-03-31T07:00:00.000Z");
    assert.equal(
      row(
        t.db,
        "SELECT COUNT(*) n FROM ledger WHERE period_id=? AND kind='grant'",
        "paid:" + next.id,
      ).n,
      0,
    );
    await assert.rejects(() => t.checkout(), /不能重复续费/);
    t.at("2028-02-29T07:00:00.000Z");
    const q3 = quota(t.db, t.user, t.current());
    assert.equal(q3.id, "paid:" + next.id);
    assert.equal(q3.available, 2000);
    assert.equal(q3.nextPeriod, null);
    assert.equal(
      row(
        t.db,
        "SELECT COUNT(*) n FROM ledger WHERE period_id=? AND kind='grant'",
        q3.id,
      ).n,
      1,
    );
    t.at("2028-03-31T07:00:00.000Z");
    assert.equal(quota(t.db, t.user, t.current()).plan, "free");
  } finally {
    t.db.close();
  }
});
test("old-period in-flight usage cannot consume renewal quota; prior free usage survives paid refund", async () => {
  const t = setup();
  try {
    t.at("2028-01-31T07:00:00.000Z");
    const free = quota(t.db, t.user, t.current());
    t.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        uid(),
        t.user,
        free.id,
        "free-used",
        "reserve",
        4,
        t.current().toISOString(),
      );
    t.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        uid(),
        t.user,
        free.id,
        "free-used",
        "consume",
        4,
        t.current().toISOString(),
      );
    const first = await t.checkout();
    let n = t.notification(t.paid(first.id));
    await t.billing.notification("payment", n.raw, n.headers);
    const q = quota(t.db, t.user, t.current());
    t.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        uid(),
        t.user,
        q.id,
        "across-month",
        "reserve",
        11,
        t.current().toISOString(),
      );
    const next = await t.checkout();
    n = t.notification(t.paid(next.id));
    await t.billing.notification("payment", n.raw, n.headers);
    await t.billing.refund(next.id, "admin", "退款未来续费周期");
    assert.equal(quota(t.db, t.user, t.current()).plan, "standard");
    assert.equal(quota(t.db, t.user, t.current()).reserved, 11);
    await t.billing.refund(first.id, "admin", "退款本期测试");
    assert.equal(quota(t.db, t.user, t.current()).plan, "free");
    assert.equal(quota(t.db, t.user, t.current()).available, 56);
    t.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        uid(),
        t.user,
        q.id,
        "across-month",
        "consume",
        4,
        t.current().toISOString(),
      );
    t.db
      .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)")
      .run(
        uid(),
        t.user,
        q.id,
        "across-month",
        "release",
        7,
        t.current().toISOString(),
      );
    assert.equal(quota(t.db, t.user, t.current()).available, 56);
    assert.equal(
      row(
        t.db,
        "SELECT COUNT(*) n FROM ledger WHERE period_id=? AND kind='grant'",
        free.id,
      ).n,
      1,
    );
  } finally {
    t.db.close();
  }
});
test("refund processing retains rights, success revokes once, and late payment/refund notifications do not resurrect rights", async () => {
  const t = setup();
  try {
    const order = await t.checkout();
    const paid = t.notification(t.paid(order.id));
    await t.billing.notification("payment", paid.raw, paid.headers);
    t.setRefundProcessing(true);
    const pending = await t.billing.refund(order.id, "admin", "退款测试原因");
    assert.equal(pending.status, "refund_pending");
    assert.equal(quota(t.db, t.user).plan, "standard");
    const record = t.billing.get(order.id);
    const result = {
      ...t.refunds.get(record.refund_no),
      mchid: t.config.mchId,
      refund_status: "SUCCESS",
    };
    const refunded = t.notification(result, "refund");
    await t.billing.notification("refund", refunded.raw, refunded.headers);
    await t.billing.notification("refund", refunded.raw, refunded.headers);
    const latePaid = t.notification(t.paid(order.id));
    await t.billing.notification("payment", latePaid.raw, latePaid.headers);
    assert.equal(t.billing.get(order.id).status, "refunded");
    assert.equal(quota(t.db, t.user).plan, "free");
    assert.equal(
      row(
        t.db,
        "SELECT COUNT(*) n FROM ledger WHERE request_id=? AND kind='revoke'",
        "refund:" + order.id,
      ).n,
      1,
    );
    const later = t.notification(
      { ...result, refund_status: "ABNORMAL" },
      "refund",
    );
    await t.billing.notification("refund", later.raw, later.headers);
    assert.equal(t.billing.get(order.id).status, "refunded");
  } finally {
    t.db.close();
  }
});
test("expired unpaid orders are closed by background reconciliation", async () => {
  const t = setup();
  try {
    const order = await t.checkout();
    t.at(new Date(Date.parse(order.expiresAt) + 1000).toISOString());
    await t.billing.tick();
    assert.equal(t.billing.get(order.id).status, "closed");
    assert.equal(t.transactions.get(order.id).trade_state, "CLOSED");
    assert.equal(row(t.db, "SELECT COUNT(*) n FROM subscriptions").n, 0);
  } finally {
    t.db.close();
  }
});
test("a late success for a closed order cannot double-activate an already active subscription", async () => {
  const t = setup();
  try {
    const old = await t.checkout();
    await t.billing.close(old.id, t.user);
    const current = await t.checkout();
    let n = t.notification(t.paid(current.id));
    await t.billing.notification("payment", n.raw, n.headers);
    n = t.notification(t.paid(old.id));
    await t.billing.notification("payment", n.raw, n.headers);
    assert.equal(t.billing.get(old.id).status, "exception");
    assert.ok(t.billing.get(old.id).transaction_id);
    assert.equal(row(t.db, "SELECT COUNT(*) n FROM subscriptions").n, 1);
    await t.billing.refund(old.id, "admin", "已付款未交付服务原路退款");
    assert.equal(t.billing.get(old.id).status, "refunded");
    assert.equal(quota(t.db, t.user).id, "paid:" + current.id);
  } finally {
    t.db.close();
  }
});
test("price versions are immutable and stale clients must reconfirm new prices", async () => {
  const t = setup();
  try {
    const order = await t.checkout();
    await t.billing.close(order.id, t.user);
    const replacement = createBilling(t.db, {
      ...paymentFixture().billing,
      plans: t.billing
        .status()
        .plans.map((p) => ({ ...p, priceFen: p.priceFen + 100 })),
    });
    await assert.rejects(
      () =>
        replacement.checkout(
          t.user,
          { key: uid(), channel: "native", planVersion: t.version },
          "203.0.113.8",
        ),
      /套餐已变更/,
    );
    assert.equal(
      replacement.publicOrder(replacement.get(order.id)).amount,
      1234,
    );
    assert.equal(
      replacement.publicOrder(replacement.get(order.id)).plan.priceFen,
      1234,
    );
  } finally {
    t.db.close();
  }
});

test("HTTP routes authenticate owner, reject forged amounts/returns, verify raw callbacks, restrict refunds, preserve financial records", async () => {
  const fixture = paymentFixture();
  const service = createApp({
    database: ":memory:",
    production: true,
    origin: "https://ideas.example",
    authMode: "smtp",
    adminEmails: ["admin@example.com"],
    ai: {
      mode: "openai",
      baseURL: "https://ai.example/v1",
      apiKey: "test",
      quickModel: "quick",
      deepModel: "deep",
      provider: "test",
      policyURL: "https://ai.example/privacy",
    },
    billing: fixture.billing,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const users = ["buyer", "other", "admin"].map((name) => {
    const id = uid(),
      token = uid();
    service.db
      .prepare("INSERT INTO users VALUES(?,?,?,?,NULL)")
      .run(id, `${name}@example.com`, new Date().toISOString(), "test");
    service.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(
        createHash("sha256").update(token).digest("hex"),
        id,
        Date.now() + 3600000,
      );
    return { id, cookie: `idea_session=${token}` };
  });
  const call = async (
    path: string,
    who = 0,
    body?: unknown,
    method?: string,
  ) => {
    const r = await fetch(base + "/api" + path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        "X-Idea-Client": "1",
        Cookie: users[who].cookie,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  };
  try {
    const version = service.billing.status().plans[0].version;
    const input = {
      key: uid(),
      channel: "native",
      planVersion: version,
      accepted: true,
    };
    assert.equal(
      (await call("/orders", 0, { ...input, amount: 1 })).status,
      400,
    );
    const order = (await call("/orders", 0, input)).data;
    assert.equal(order.amount, 1234);
    assert.equal((await call(`/orders/${order.id}`, 1)).status, 404);
    assert.equal(
      (await call(`/orders/${order.id}/refresh`, 1, {})).status,
      404,
    );
    assert.equal(
      (await call(`/orders/${order.id}/success`, 0, {})).status,
      404,
    );
    assert.equal((await call("/quota")).data.plan, "free");
    const event = fixture.notification(fixture.paid(order.id));
    const headers = Object.fromEntries(event.headers.entries());
    let r = await fetch(base + "/api/payments/wechat/notify", {
      method: "POST",
      headers: { ...headers, "Wechatpay-Signature": "fake" },
      body: event.raw,
    });
    assert.equal(r.status, 400);
    assert.equal((await call("/quota")).data.plan, "free");
    r = await fetch(base + "/api/payments/wechat/notify", {
      method: "POST",
      headers,
      body: event.raw,
    });
    assert.equal(r.status, 204);
    assert.equal((await call("/quota")).data.plan, "standard");
    assert.equal(
      (
        await call(`/admin/payments/${order.id}/refund`, 0, {
          reason: "非法退款测试",
          confirm: true,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(`/admin/payments/${order.id}/refund`, 2, {
          reason: "缺少确认字段",
        })
      ).status,
      400,
    );
    assert.equal(
      (await call(`/orders/${order.id}/support`, 0, { reason: "申请支持测试" }))
        .status,
      200,
    );
    assert.equal(
      (await call(`/admin/payments`, 2)).data.items[0].supportReason,
      "申请支持测试",
    );
    assert.equal(
      (await call("/account/delete", 0, { code: "123456" })).data.code,
      "PAYMENT_HISTORY",
    );
    assert.equal(
      (
        await call(`/admin/payments/${order.id}/refund`, 2, {
          reason: "用户支持已核实退款",
          confirm: true,
        })
      ).status,
      200,
    );
    assert.equal((await call("/quota")).data.plan, "free");
  } finally {
    service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.db.close();
  }
});
