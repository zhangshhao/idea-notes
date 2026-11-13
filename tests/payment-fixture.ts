import {
  createCipheriv,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import assert from "node:assert/strict";
import { WechatPay, type WechatConfig } from "../server/payments/wechat";
import type { BillingConfig } from "../server/payments/billing";

const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
export function paymentFixture() {
  const config: WechatConfig = {
    appId: "wxtest123456789012",
    mchId: "1900000001",
    serialNo: "123ABC",
    privateKey: merchant.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKeyId: "PUB_KEY_ID_TEST123",
    publicKey: platform.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
    apiV3Key: "12345678901234567890123456789012",
    notifyUrl: "https://ideas.example/api/payments/wechat/notify",
    refundNotifyUrl: "https://ideas.example/api/payments/wechat/refund-notify",
    h5Enabled: true,
  };
  const calls: { path: string; method: string; body: any }[] = [];
  const transactions = new Map<string, any>();
  const refunds = new Map<string, any>();
  let createTimeout = false;
  let invalidSignature = false;
  let refundProcessing = false;
  function headers(raw: string) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(12).toString("hex");
    return new Headers({
      "Content-Type": "application/json",
      "Request-ID": "test-request",
      "Wechatpay-Timestamp": timestamp,
      "Wechatpay-Nonce": nonce,
      "Wechatpay-Serial": config.publicKeyId,
      "Wechatpay-Signature": sign(
        "RSA-SHA256",
        Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),
        platform.privateKey,
      ).toString("base64"),
    });
  }
  function response(body: unknown, status = 200) {
    const raw = body === null ? "" : JSON.stringify(body);
    const h = headers(raw);
    if (invalidSignature) h.set("Wechatpay-Signature", "invalid");
    return new Response(raw || null, { status, headers: h });
  }
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    const method = init?.method || "GET";
    const raw = String(init?.body || "");
    const h = new Headers(init?.headers);
    const auth = h.get("authorization") || "";
    const fields = Object.fromEntries(
      [...auth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    assert.equal(fields.mchid, config.mchId);
    assert.equal(fields.serial_no, config.serialNo);
    assert.equal(h.get("Wechatpay-Serial"), config.publicKeyId);
    assert.ok(
      verify(
        "RSA-SHA256",
        Buffer.from(
          `${method}\n${url.pathname + url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${raw}\n`,
        ),
        merchant.publicKey,
        Buffer.from(fields.signature, "base64"),
      ),
    );
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: url.pathname + url.search, method, body });
    if (
      ["/v3/pay/transactions/native", "/v3/pay/transactions/h5"].includes(
        url.pathname,
      )
    ) {
      assert.equal(body.amount.currency, "CNY");
      assert.ok(body.amount.total > 0);
      assert.equal(body.appid, config.appId);
      assert.equal(body.mchid, config.mchId);
      if (!transactions.has(body.out_trade_no))
        transactions.set(body.out_trade_no, {
          appid: config.appId,
          mchid: config.mchId,
          out_trade_no: body.out_trade_no,
          trade_state: "NOTPAY",
          amount: { ...body.amount },
        });
      if (createTimeout) {
        createTimeout = false;
        throw new Error("connection lost after provider accepted order");
      }
      return response(
        url.pathname.endsWith("/native")
          ? { code_url: `weixin://wxpay/bizpayurl?pr=${body.out_trade_no}` }
          : {
              h5_url: `https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=${body.out_trade_no}`,
            },
      );
    }
    if (url.pathname.startsWith("/v3/pay/transactions/out-trade-no/")) {
      const id = url.pathname.split("/")[5];
      const record = transactions.get(id);
      if (!record) return response({ code: "ORDER_NOT_EXIST" }, 404);
      if (url.pathname.endsWith("/close")) {
        if (record.trade_state === "SUCCESS")
          return response({ code: "ORDERPAID" }, 400);
        record.trade_state = "CLOSED";
        return response(null, 204);
      }
      return response(record);
    }
    if (url.pathname === "/v3/refund/domestic/refunds") {
      const payment = transactions.get(body.out_trade_no);
      assert.ok(payment);
      assert.equal(body.amount.total, payment.amount.total);
      assert.equal(body.amount.refund, payment.amount.total);
      if (!refunds.has(body.out_refund_no))
        refunds.set(body.out_refund_no, {
          out_trade_no: body.out_trade_no,
          out_refund_no: body.out_refund_no,
          transaction_id: payment.transaction_id,
          refund_id: "wx-refund-" + body.out_refund_no,
          status: refundProcessing ? "PROCESSING" : "SUCCESS",
          amount: body.amount,
        });
      return response(refunds.get(body.out_refund_no));
    }
    if (url.pathname.startsWith("/v3/refund/domestic/refunds/"))
      return response(
        refunds.get(url.pathname.split("/").at(-1)!) || {
          code: "RESOURCE_NOT_EXISTS",
        },
        refunds.has(url.pathname.split("/").at(-1)!) ? 200 : 404,
      );
    throw new Error("Unexpected API " + url.pathname);
  };
  const provider = new WechatPay(config, transport);
  const billing: BillingConfig = {
    provider,
    enabled: true,
    allowRefunds: true,
    publicOrigin: "https://ideas.example",
    supportEmail: "support@example.com",
    refundPolicyUrl: "https://ideas.example/refunds",
    plans: [
      {
        id: "standard",
        name: "标准版",
        priceFen: 1234,
        points: 2000,
        currency: "CNY",
        rateVersion: "demo-v1",
        deep: true,
      },
      {
        id: "pro",
        name: "专业版",
        priceFen: 3456,
        points: 6000,
        currency: "CNY",
        rateVersion: "demo-v1",
        deep: true,
      },
    ],
  };
  function paid(id: string) {
    const r = transactions.get(id);
    assert.ok(r);
    Object.assign(r, {
      trade_state: "SUCCESS",
      transaction_id: "wx-" + id,
      success_time: new Date().toISOString(),
    });
    return structuredClone(r);
  }
  function notification(
    data: any,
    kind: "payment" | "refund" = "payment",
    id = randomBytes(16).toString("hex"),
  ) {
    const nonce = randomBytes(6).toString("hex");
    const aad = kind === "payment" ? "transaction" : "refund";
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(config.apiV3Key),
      Buffer.from(nonce),
    );
    cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const raw = JSON.stringify({
      id,
      event_type:
        kind === "payment"
          ? "TRANSACTION.SUCCESS"
          : `REFUND.${data.refund_status}`,
      resource_type: "encrypt-resource",
      resource: {
        algorithm: "AEAD_AES_256_GCM",
        original_type: aad,
        ciphertext: encrypted,
        nonce,
        associated_data: aad,
      },
    });
    return { raw, headers: headers(raw), id };
  }
  return {
    config,
    provider,
    billing,
    calls,
    transactions,
    refunds,
    paid,
    notification,
    headers,
    timeoutNextCreate: () => {
      createTimeout = true;
    },
    setBadSignature: (v: boolean) => {
      invalidSignature = v;
    },
    setRefundProcessing: (v: boolean) => {
      refundProcessing = v;
    },
  };
}
