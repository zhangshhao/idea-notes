import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "../db";
import { assert, BusinessError, quota, row, rows, uid } from "../domain";
import { subscriptionBoundary } from "./calendar";
import {
  paymentSchema,
  refundSchema,
  WechatError,
  type WechatPay,
  type PaymentResult,
  type RefundResult,
} from "./wechat";

export const planSchema = z.object({
  id: z.enum(["standard", "pro"]),
  name: z.string().min(1),
  priceFen: z.number().int().positive().max(10000000),
  points: z.number().int().positive().max(10000000),
  currency: z.literal("CNY"),
  rateVersion: z.literal("demo-v1"),
  deep: z.literal(true),
});
export type Plan = z.infer<typeof planSchema> & { version: string };
export interface BillingConfig {
  provider?: WechatPay;
  plans?: z.input<typeof planSchema>[];
  enabled?: boolean;
  missing?: string[];
  supportEmail?: string;
  refundPolicyUrl?: string;
  publicOrigin?: string;
  publicBasePath?: string;
  allowRefunds?: boolean;
  clock?: () => Date;
}
type Order = Record<string, any>;
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const unresolved = ["creating", "pending", "unknown", "exception"];
export function plansFromEnv(
  env: NodeJS.ProcessEnv,
): z.input<typeof planSchema>[] {
  return (["standard", "pro"] as const).flatMap((id) => {
    const prefix = id === "standard" ? "STANDARD" : "PRO";
    const price = env[`${prefix}_PRICE_FEN`];
    if (!price) return [];
    return [
      planSchema.parse({
        id,
        name: id === "standard" ? "标准版" : "专业版",
        priceFen: Number(price),
        points: Number(
          env[`${prefix}_POINTS`] || (id === "standard" ? 2000 : 6000),
        ),
        currency: "CNY",
        rateVersion: "demo-v1",
        deep: true,
      }),
    ];
  });
}
export function createBilling(db: DB, config: BillingConfig = {}) {
  const provider = config.provider;
  const date = () => config.clock?.() || new Date();
  const stamp = () => date().toISOString();
  const plans: Plan[] = (config.plans || []).map((input) => {
    const data = planSchema.parse(input);
    const version = digest(JSON.stringify(data)).slice(0, 24);
    db.prepare("INSERT OR IGNORE INTO payment_plans VALUES(?,?,?)").run(
      version,
      JSON.stringify(data),
      stamp(),
    );
    return { ...data, version };
  });
  const missing = [...(config.missing || [])];
  if (!provider && !missing.length) missing.push("微信支付商户配置");
  if (!plans.some((p) => p.id === "standard"))
    missing.push("STANDARD_PRICE_FEN");
  if (!plans.some((p) => p.id === "pro")) missing.push("PRO_PRICE_FEN");
  if (!config.supportEmail || !z.email().safeParse(config.supportEmail).success)
    missing.push("PAYMENT_SUPPORT_EMAIL");
  if (!config.refundPolicyUrl || !/^https:\/\//.test(config.refundPolicyUrl))
    missing.push("PAYMENT_REFUND_POLICY_URL");
  if (!config.publicOrigin || !/^https:\/\//.test(config.publicOrigin))
    missing.push("APP_ORIGIN (HTTPS)");
  const enabled = !!config.enabled && missing.length === 0;
  const locks = new Map<string, Promise<unknown>>();
  async function lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const existing = locks.get(id);
    if (existing) {
      await existing.catch(() => {});
      return lock(id, fn);
    }
    const task = fn();
    locks.set(id, task);
    try {
      return await task;
    } finally {
      if (locks.get(id) === task) locks.delete(id);
    }
  }
  function audit(actor: string, action: string, data: unknown) {
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?)").run(
      uid(),
      actor,
      action,
      JSON.stringify(data),
      stamp(),
    );
  }
  function get(id: string, owner?: string): Order {
    const order = owner
      ? row(
          db,
          "SELECT * FROM payment_orders WHERE id=? AND user_id=?",
          id,
          owner,
        )
      : row(db, "SELECT * FROM payment_orders WHERE id=?", id);
    assert(order, 404, "ORDER_NOT_FOUND", "找不到此订单");
    return order;
  }
  function planFor(order: Order): Plan {
    const saved = row(
      db,
      "SELECT data FROM payment_plans WHERE version=?",
      order.plan_version,
    );
    return { ...JSON.parse(saved.data), version: order.plan_version };
  }
  function publicOrder(order: Order) {
    const subscription = row(
      db,
      "SELECT starts,ends,state FROM subscriptions WHERE order_id=?",
      order.id,
    );
    let paymentUrl = order.payment_url;
    if (
      order.channel === "h5" &&
      (!order.url_created_at ||
        Date.parse(order.url_created_at) <= date().getTime() - 5 * 60000)
    )
      paymentUrl = null;
    if (order.channel === "h5" && paymentUrl && config.publicOrigin) {
      const url = new URL(paymentUrl);
      url.searchParams.set(
        "redirect_url",
        `${config.publicOrigin}${config.publicBasePath || "/"}?payment_order=${order.id}`,
      );
      paymentUrl = url.href;
    }
    return {
      id: order.id,
      plan: planFor(order),
      amount: order.amount,
      currency: order.currency,
      channel: order.channel,
      status: order.status,
      entitlement: order.entitlement,
      createdAt: order.created_at,
      expiresAt: order.expires_at,
      paidAt: order.paid_at,
      startsAt: subscription?.starts,
      endsAt: subscription?.ends,
      renewal: !!order.parent_order_id,
      paymentUrl:
        order.status === "pending" && order.expires_at > stamp()
          ? paymentUrl
          : null,
      refundStatus: order.refund_status,
      supportRequested: !!order.support_reason,
      lastError: order.last_error,
      canRetry: unresolved.includes(order.status),
      supportEmail: config.supportEmail || null,
    };
  }
  function status() {
    return {
      provider: "wechat",
      enabled,
      configured: !!provider,
      h5Enabled: !!provider?.config.h5Enabled,
      plans,
      setupRequired: !provider,
      missing,
      activationRequired: !config.enabled,
      supportEmail: config.supportEmail || null,
      refundPolicyUrl: config.refundPolicyUrl || null,
      refundEnabled: !!config.allowRefunds,
    };
  }
  function active(user: string) {
    return row(
      db,
      "SELECT * FROM subscriptions WHERE user_id=? AND state='active' AND starts<=? AND ends>? ORDER BY starts DESC LIMIT 1",
      user,
      stamp(),
      stamp(),
    );
  }
  function future(user: string) {
    return row(
      db,
      "SELECT * FROM subscriptions WHERE user_id=? AND state='active' AND starts>? ORDER BY starts LIMIT 1",
      user,
      stamp(),
    );
  }
  function fail(orderId: string, error: unknown) {
    const code =
      error instanceof WechatError ? error.code : "PAYMENT_UNCONFIRMED";
    const retry = date().getTime() + 60000;
    db.prepare(
      "UPDATE payment_orders SET last_error=?,next_check_at=?,check_attempts=check_attempts+1,status=CASE WHEN status='creating' THEN 'unknown' ELSE status END WHERE id=?",
    ).run(
      "支付渠道暂未确认，请刷新订单或联系支持。",
      new Date(retry).toISOString(),
      orderId,
    );
    audit("system", "payment.error", {
      orderId,
      code,
      requestId: error instanceof WechatError ? error.requestId : null,
    });
  }
  function validatePayment(order: Order, result: PaymentResult) {
    assert(
      provider &&
        result.mchid === provider.config.mchId &&
        result.appid === provider.config.appId &&
        result.out_trade_no === order.id,
      400,
      "PAYMENT_MISMATCH",
      "支付订单或商户不匹配",
    );
    if (["SUCCESS", "REFUND"].includes(result.trade_state))
      assert(
        result.amount?.total === order.amount &&
          result.amount?.currency === order.currency &&
          result.transaction_id,
        400,
        "AMOUNT_MISMATCH",
        "支付金额、币种或交易编号不匹配",
      );
  }
  function markException(order: Order, message: string) {
    db.prepare(
      "UPDATE payment_orders SET status='exception',last_error=?,next_check_at=? WHERE id=?",
    ).run(
      message,
      new Date(date().getTime() + 3600000).toISOString(),
      order.id,
    );
    audit("system", "payment.exception", {
      orderId: order.id,
      reason: message,
    });
  }
  function applyPayment(result: PaymentResult) {
    return transaction(db, () => {
      const order = get(result.out_trade_no);
      validatePayment(order, result);
      if (result.trade_state === "SUCCESS") {
        if (
          order.transaction_id &&
          order.transaction_id !== result.transaction_id
        )
          throw new BusinessError(
            409,
            "TRANSACTION_MISMATCH",
            "订单交易编号不一致",
          );
        const reused = row(
          db,
          "SELECT id FROM payment_orders WHERE transaction_id=? AND id<>?",
          result.transaction_id,
          order.id,
        );
        assert(
          !reused,
          409,
          "DUPLICATE_TRANSACTION",
          "同一交易不可发放两次权益",
        );
        if (
          order.entitlement === "revoked" ||
          order.status === "refunded" ||
          order.status === "refund_pending"
        )
          return;
        if (order.entitlement === "granted") return;
        // Payment is recorded even when fulfillment requires manual reconciliation.
        db.prepare(
          "UPDATE payment_orders SET transaction_id=?,paid_at=?,last_error=NULL WHERE id=?",
        ).run(result.transaction_id!, result.success_time || stamp(), order.id);
        const parent = order.parent_order_id
          ? row(
              db,
              "SELECT * FROM subscriptions WHERE order_id=?",
              order.parent_order_id,
            )
          : null;
        const current = active(order.user_id);
        const pending = future(order.user_id);
        if (
          pending ||
          (current && current.order_id !== order.parent_order_id) ||
          (parent && parent.state !== "active")
        ) {
          markException(
            order,
            "付款已确认，但服务周期发生变化。请联系支持核对或原路退款。",
          );
          return;
        }
        const activatedAt = stamp();
        const anchor = parent?.anchor || activatedAt;
        const monthIndex = parent ? parent.month_index + 1 : 0;
        const starts = parent?.ends || activatedAt;
        const ends = subscriptionBoundary(anchor, monthIndex + 1);
        if (ends <= stamp()) {
          markException(
            order,
            "付款确认延迟，预定服务周期已结束。请联系支持原路退款。",
          );
          return;
        }
        const plan = planFor(order);
        const periodId = `paid:${order.id}`;
        db.prepare("INSERT INTO periods VALUES(?,?,?,?,?,?)").run(
          periodId,
          order.user_id,
          starts,
          ends,
          plan.id,
          plan.points,
        );
        db.prepare("INSERT INTO subscriptions VALUES(?,?,?,?,?,?,?,?)").run(
          order.id,
          order.user_id,
          periodId,
          anchor,
          monthIndex,
          starts,
          ends,
          "active",
        );
        db.prepare(
          "UPDATE payment_orders SET status='paid',entitlement='granted',last_error=NULL,payment_url=NULL WHERE id=?",
        ).run(order.id);
        // Future renewals create no quota grant until that period actually starts.
        quota(db, order.user_id, date());
        audit("system", "payment.fulfilled", {
          orderId: order.id,
          periodId,
          starts,
          ends,
        });
      } else if (["CLOSED", "REVOKED"].includes(result.trade_state)) {
        if (
          !order.transaction_id &&
          !["paid", "refund_pending", "refunded"].includes(order.status)
        )
          db.prepare(
            "UPDATE payment_orders SET status='closed',payment_url=NULL,last_error=NULL WHERE id=?",
          ).run(order.id);
      } else if (
        result.trade_state === "REFUND" &&
        !order.refund_no &&
        order.status !== "refunded"
      )
        markException(order, "微信侧已进入退款流程，请由支持人员核对该订单。");
      db.prepare(
        "UPDATE payment_orders SET last_checked_at=?,next_check_at=?,check_attempts=check_attempts+1 WHERE id=?",
      ).run(
        stamp(),
        new Date(date().getTime() + 60000).toISOString(),
        order.id,
      );
    });
  }
  function applyRefund(result: RefundResult) {
    return transaction(db, () => {
      const order = get(result.out_trade_no);
      assert(
        (!result.mchid || result.mchid === provider?.config.mchId) &&
          result.out_refund_no === order.refund_no &&
          result.transaction_id === order.transaction_id &&
          result.amount.total === order.amount &&
          result.amount.refund === order.amount &&
          (!result.amount.currency || result.amount.currency === "CNY"),
        400,
        "REFUND_MISMATCH",
        "退款商户、编号或金额不匹配",
      );
      const state = result.refund_status || result.status;
      assert(state, 400, "REFUND_STATE", "退款状态缺失");
      if (order.status === "refunded") return;
      if (state === "SUCCESS") {
        const sub = row(
          db,
          "SELECT * FROM subscriptions WHERE order_id=?",
          order.id,
        );
        if (sub) {
          const entries = rows(
            db,
            "SELECT kind,SUM(amount) amount FROM ledger WHERE period_id=? GROUP BY kind",
            sub.period_id,
          );
          const amount = (kind: string) =>
            Number(entries.find((e) => e.kind === kind)?.amount || 0);
          const available = Math.max(
            0,
            amount("grant") -
              amount("reserve") +
              amount("release") -
              amount("revoke"),
          );
          db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)").run(
            `revoke:${order.id}`,
            order.user_id,
            sub.period_id,
            `refund:${order.id}`,
            "revoke",
            available,
            stamp(),
          );
          db.prepare(
            "UPDATE subscriptions SET state='revoked' WHERE order_id=?",
          ).run(order.id);
        }
        db.prepare(
          "UPDATE payment_orders SET status='refunded',entitlement='revoked',refund_status='SUCCESS',payment_url=NULL,last_error=NULL WHERE id=?",
        ).run(order.id);
        audit("system", "payment.refunded", {
          orderId: order.id,
          refundId: result.refund_id,
        });
      } else if (state === "PROCESSING")
        db.prepare(
          "UPDATE payment_orders SET status='refund_pending',refund_status='PROCESSING' WHERE id=?",
        ).run(order.id);
      else {
        db.prepare("UPDATE payment_orders SET refund_status=? WHERE id=?").run(
          state,
          order.id,
        );
        markException(order, "退款需要人工核对，请联系支持处理。");
      }
    });
  }
  async function reconcile(id: string, force = false) {
    assert(provider, 503, "PAYMENT_NOT_CONFIGURED", "微信支付尚未配置");
    return lock(id, async () => {
      let order = get(id);
      if (
        order.status === "refunded" ||
        (order.status === "paid" && !order.refund_no) ||
        (!force &&
          order.last_checked_at &&
          Date.parse(order.last_checked_at) >
            date().getTime() - (order.refund_no ? 60000 : 5000))
      )
        return publicOrder(order);
      try {
        if (order.refund_no) {
          applyRefund(await provider.queryRefund(order.refund_no));
        } else {
          const result = await provider.query(id);
          applyPayment(result);
          order = get(id);
          if (
            result.trade_state === "NOTPAY" &&
            order.expires_at <= stamp() &&
            !order.transaction_id
          ) {
            await provider.close(id);
            db.prepare(
              "UPDATE payment_orders SET status='closed',last_error=NULL,payment_url=NULL WHERE id=? AND transaction_id IS NULL",
            ).run(id);
          }
        }
      } catch (error) {
        // A signed ORDER_NOT_EXIST after expiry is conclusive; timeouts are not.
        if (
          error instanceof WechatError &&
          error.code === "ORDER_NOT_EXIST" &&
          order.expires_at <= stamp() &&
          !order.transaction_id
        )
          db.prepare(
            "UPDATE payment_orders SET status='closed',payment_url=NULL,last_error=NULL WHERE id=?",
          ).run(id);
        else fail(id, error);
      }
      db.prepare(
        "UPDATE payment_orders SET last_checked_at=?,next_check_at=? WHERE id=?",
      ).run(
        stamp(),
        new Date(
          date().getTime() +
            (order.refund_no
              ? Math.min(1800000, 60000 * Math.max(1, order.check_attempts))
              : 60000),
        ).toISOString(),
        id,
      );
      return publicOrder(get(id));
    });
  }
  async function checkout(
    owner: string,
    input: { planVersion: string; key: string; channel: "native" | "h5" },
    ip: string,
  ) {
    assert(
      enabled && provider,
      503,
      "PAYMENT_NOT_READY",
      "微信支付待商户开通与配置完成后开放",
    );
    assert(
      input.channel !== "h5" || provider.config.h5Enabled,
      400,
      "H5_NOT_ENABLED",
      "手机 H5 支付尚未开通，请在电脑上使用微信扫码",
    );
    let order = transaction(db, () => {
      const existing = row(
        db,
        "SELECT * FROM payment_orders WHERE user_id=? AND client_key=?",
        owner,
        input.key,
      );
      if (existing) {
        assert(
          existing.plan_version === input.planVersion &&
            existing.channel === input.channel,
          409,
          "ORDER_KEY_CONFLICT",
          "重复提交参数不一致",
        );
        return existing;
      }
      const plan = plans.find((p) => p.version === input.planVersion);
      assert(plan, 409, "PLAN_CHANGED", "套餐已变更，请刷新并重新确认价格");
      const outstanding = row(
        db,
        "SELECT id FROM payment_orders WHERE user_id=? AND status IN ('creating','pending','unknown','exception','refund_pending')",
        owner,
      );
      if (outstanding)
        throw new BusinessError(
          409,
          "ORDER_PENDING",
          "已有待处理订单，请先查看或关闭原订单",
          { orderId: outstanding.id },
        );
      assert(
        !future(owner),
        409,
        "RENEWAL_EXISTS",
        "已购买下一周期，不能重复续费",
      );
      const current = active(owner);
      const id = randomBytes(16).toString("hex");
      const time = stamp();
      db.prepare(
        `INSERT INTO payment_orders(id,user_id,client_key,plan_version,amount,channel,status,parent_order_id,created_at,expires_at,next_check_at) VALUES(?,?,?,?,?,?,'creating',?,?,?,?)`,
      ).run(
        id,
        owner,
        input.key,
        plan.version,
        plan.priceFen,
        input.channel,
        current?.order_id || null,
        time,
        new Date(date().getTime() + 30 * 60000).toISOString(),
        time,
      );
      audit(owner, "payment.created", {
        orderId: id,
        planVersion: plan.version,
        amount: plan.priceFen,
      });
      return get(id);
    });
    if (!["creating", "unknown", "pending"].includes(order.status))
      return publicOrder(order);
    return lock(order.id, async () => {
      order = get(order.id);
      if (
        order.status === "pending" &&
        order.payment_url &&
        order.expires_at > stamp() &&
        (order.channel === "native" ||
          Date.parse(order.url_created_at) > date().getTime() - 4 * 60000)
      )
        return publicOrder(order);
      if (order.expires_at <= new Date(date().getTime() + 60000).toISOString())
        throw new BusinessError(
          409,
          "ORDER_EXPIRED",
          "订单即将到期，请查单关闭后重新购买",
          { orderId: order.id },
        );
      try {
        if (order.status === "unknown" || order.status === "pending") {
          try {
            const result = await provider.query(order.id);
            applyPayment(result);
            if (result.trade_state !== "NOTPAY")
              return publicOrder(get(order.id));
          } catch (error) {
            if (!(
              error instanceof WechatError && error.code === "ORDER_NOT_EXIST"
            ))
              throw error;
          }
        }
        const url = await provider.create(
          {
            id: order.id,
            amount: order.amount,
            description: `一念想法笔记 · ${planFor(order).name}一个月`,
            expiresAt: order.expires_at,
            channel: order.channel,
          },
          ip,
        );
        db.prepare(
          "UPDATE payment_orders SET status='pending',payment_url=?,url_created_at=?,last_error=NULL,next_check_at=? WHERE id=? AND status IN ('creating','pending','unknown')",
        ).run(
          url,
          stamp(),
          new Date(date().getTime() + 60000).toISOString(),
          order.id,
        );
      } catch (error) {
        fail(order.id, error);
      }
      return publicOrder(get(order.id));
    });
  }
  async function close(id: string, owner: string) {
    get(id, owner);
    assert(provider, 503, "PAYMENT_NOT_CONFIGURED", "微信支付尚未配置");
    return lock(id, async () => {
      const order = get(id, owner);
      assert(
        !order.transaction_id &&
          ["creating", "pending", "unknown", "closed"].includes(order.status),
        409,
        "ORDER_NOT_CLOSABLE",
        "付款已确认或正在核对，不能关闭",
      );
      try {
        const result = await provider.query(id);
        applyPayment(result);
        if (result.trade_state === "NOTPAY") {
          await provider.close(id);
          db.prepare(
            "UPDATE payment_orders SET status='closed',payment_url=NULL,last_error=NULL WHERE id=? AND transaction_id IS NULL",
          ).run(id);
        }
      } catch (error) {
        if (error instanceof WechatError && error.code === "ORDER_NOT_EXIST")
          db.prepare(
            "UPDATE payment_orders SET status='closed',payment_url=NULL WHERE id=? AND transaction_id IS NULL",
          ).run(id);
        else fail(id, error);
      }
      return publicOrder(get(id));
    });
  }
  async function refund(id: string, actor: string, reason: string) {
    assert(
      provider && config.allowRefunds,
      503,
      "REFUND_NOT_ENABLED",
      "退款操作未启用，请由财务在商户平台核对",
    );
    return lock(id, async () => {
      const order = transaction(db, () => {
        const order = get(id);
        if (order.status === "refunded") return order;
        assert(
          order.transaction_id &&
            ["paid", "exception", "refund_pending"].includes(order.status),
          409,
          "REFUND_NOT_ALLOWED",
          "订单尚未确认收款",
        );
        // A current-period refund must not silently shift an already-paid renewal.
        assert(
          !row(
            db,
            "SELECT s.order_id FROM subscriptions s JOIN payment_orders p ON p.id=s.order_id WHERE p.parent_order_id=? AND s.state='active' AND s.starts>?",
            id,
            stamp(),
          ),
          409,
          "REFUND_RENEWAL_FIRST",
          "请先处理下一周期续费订单，再退款当前周期",
        );
        const refundNo =
          order.refund_no || `R${randomBytes(15).toString("hex")}`;
        db.prepare(
          "UPDATE payment_orders SET refund_no=?,refund_reason=COALESCE(refund_reason,?),status='refund_pending',refund_status=COALESCE(refund_status,'PROCESSING') WHERE id=?",
        ).run(refundNo, reason, id);
        audit(actor, "payment.refund_requested", {
          orderId: id,
          reason,
          refundNo,
        });
        return get(id);
      });
      if (order.status === "refunded") return publicOrder(order);
      try {
        applyRefund(
          await provider.refund(
            order.id,
            order.refund_no,
            order.amount,
            order.refund_reason,
          ),
        );
      } catch (error) {
        fail(id, error);
      }
      return publicOrder(get(id));
    });
  }
  async function notification(
    kind: "payment" | "refund",
    raw: string,
    headers: Headers,
  ) {
    assert(provider, 503, "PAYMENT_NOT_CONFIGURED", "微信支付尚未配置");
    const event = provider.notification(raw, headers);
    const hash = digest(raw);
    const old = row(
      db,
      "SELECT body_hash FROM payment_events WHERE id=?",
      event.id,
    );
    if (old) {
      assert(
        old.body_hash === hash,
        409,
        "EVENT_CONFLICT",
        "回调事件内容不一致",
      );
      return;
    }
    let orderId: string;
    if (kind === "payment") {
      assert(
        event.type === "TRANSACTION.SUCCESS" &&
          event.resourceType === "transaction",
        400,
        "EVENT_TYPE",
        "不支持的支付通知",
      );
      const result = paymentSchema.parse(event.data);
      assert(
        result.trade_state === "SUCCESS",
        400,
        "EVENT_STATE",
        "支付通知状态错误",
      );
      applyPayment(result);
      orderId = result.out_trade_no;
    } else {
      assert(
        ["REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED"].includes(
          event.type,
        ) && event.resourceType === "refund",
        400,
        "EVENT_TYPE",
        "不支持的退款通知",
      );
      const result = refundSchema.parse(event.data);
      assert(
        result.mchid === provider.config.mchId &&
          event.type === `REFUND.${result.refund_status}`,
        400,
        "EVENT_STATE",
        "退款通知商户或状态错误",
      );
      applyRefund(result);
      orderId = result.out_trade_no;
    }
    // A crash before inserting the receipt is safe: fulfillment/refund is independently idempotent.
    db.prepare("INSERT OR IGNORE INTO payment_events VALUES(?,?,?,?,?)").run(
      event.id,
      orderId,
      kind,
      hash,
      stamp(),
    );
  }
  let ticking = false;
  async function tick() {
    if (!provider || ticking) return;
    ticking = true;
    try {
      const due = rows(
        db,
        "SELECT id FROM payment_orders WHERE status IN ('creating','pending','unknown','refund_pending','exception') AND next_check_at<=? ORDER BY next_check_at LIMIT 20",
        stamp(),
      );
      for (const order of due) await reconcile(order.id);
    } finally {
      ticking = false;
    }
  }
  return {
    status,
    checkout,
    reconcile,
    close,
    refund,
    notification,
    tick,
    publicOrder,
    get,
    list: (owner: string) =>
      rows(
        db,
        "SELECT * FROM payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        owner,
      ).map(publicOrder),
    adminList: () =>
      rows(
        db,
        "SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 100",
      ).map((o) => ({
        ...publicOrder(o),
        userId: o.user_id,
        supportReason: o.support_reason,
      })),
    support: (id: string, owner: string, reason: string) => {
      const order = get(id, owner);
      assert(order.status !== "closed", 400, "ORDER_CLOSED", "订单已关闭");
      db.prepare("UPDATE payment_orders SET support_reason=? WHERE id=?").run(
        reason,
        id,
      );
      audit(owner, "payment.support_requested", { orderId: id });
      return publicOrder(get(id));
    },
  };
}
