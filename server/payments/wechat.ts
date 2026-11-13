import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { BusinessError } from "../domain";

export interface WechatConfig {
  appId: string;
  mchId: string;
  serialNo: string;
  privateKey: string;
  publicKeyId: string;
  publicKey: string;
  apiV3Key: string;
  notifyUrl: string;
  refundNotifyUrl: string;
  h5Enabled: boolean;
}
export interface PaymentOrder {
  id: string;
  amount: number;
  description: string;
  expiresAt: string;
  channel: "native" | "h5";
}
export class WechatError extends Error {
  constructor(
    public code: string,
    public requestId: string | null = null,
  ) {
    super("微信支付请求未确认，请查单后重试");
  }
}
const amountSchema = z.object({
  total: z.number().int().positive(),
  currency: z.literal("CNY"),
});
export const paymentSchema = z.object({
  appid: z.string(),
  mchid: z.string(),
  out_trade_no: z.string(),
  trade_state: z.enum([
    "SUCCESS",
    "NOTPAY",
    "USERPAYING",
    "CLOSED",
    "REVOKED",
    "PAYERROR",
    "REFUND",
  ]),
  transaction_id: z.string().optional(),
  success_time: z.iso.datetime({ offset: true }).optional(),
  amount: amountSchema.optional(),
});
export type PaymentResult = z.infer<typeof paymentSchema>;
export const refundSchema = z.object({
  mchid: z.string().optional(),
  out_trade_no: z.string(),
  transaction_id: z.string(),
  out_refund_no: z.string(),
  refund_id: z.string(),
  status: z.enum(["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"]).optional(),
  refund_status: z
    .enum(["SUCCESS", "PROCESSING", "CLOSED", "ABNORMAL"])
    .optional(),
  amount: z.object({
    total: z.number().int().positive(),
    refund: z.number().int().positive(),
    currency: z.literal("CNY").optional(),
  }),
});
export type RefundResult = z.infer<typeof refundSchema>;

/** API v3 direct-merchant integration, using a pinned WeChat Pay public key. */
export class WechatPay {
  private merchantKey;
  private platformKey;
  constructor(
    readonly config: WechatConfig,
    private transport: typeof fetch = fetch,
  ) {
    this.merchantKey = createPrivateKey(config.privateKey);
    this.platformKey = createPublicKey(config.publicKey);
    if (
      this.merchantKey.asymmetricKeyType !== "rsa" ||
      this.platformKey.asymmetricKeyType !== "rsa" ||
      (this.merchantKey.asymmetricKeyDetails?.modulusLength || 0) < 2048 ||
      (this.platformKey.asymmetricKeyDetails?.modulusLength || 0) < 2048
    )
      throw new Error("微信支付需要至少 2048 位 RSA 密钥");
    if (
      !/^\d{6,32}$/.test(config.mchId) ||
      !/^wx[a-zA-Z0-9]{8,30}$/.test(config.appId) ||
      !/^[A-Fa-f0-9]+$/.test(config.serialNo) ||
      !/^PUB_KEY_ID_[a-zA-Z0-9_]+$/.test(config.publicKeyId)
    )
      throw new Error("微信支付商户标识配置无效");
    if (Buffer.byteLength(config.apiV3Key) !== 32)
      throw new Error("微信支付 APIv3 密钥必须为 32 字节");
    for (const address of [config.notifyUrl, config.refundNotifyUrl]) {
      const url = new URL(address);
      if (
        url.protocol !== "https:" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error("微信支付回调必须为不带参数的 HTTPS URL");
    }
  }
  verify(raw: string, headers: Headers) {
    const timestamp = headers.get("wechatpay-timestamp") || "";
    const nonce = headers.get("wechatpay-nonce") || "";
    const signature = headers.get("wechatpay-signature") || "";
    if (
      !/^\d+$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !nonce ||
      headers.get("wechatpay-serial") !== this.config.publicKeyId ||
      !signature ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) ||
      Buffer.from(signature, "base64").length !==
        Math.ceil(
          (this.platformKey.asymmetricKeyDetails?.modulusLength || 2048) / 8,
        ) ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),
        this.platformKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new WechatError("INVALID_SIGNATURE");
  }
  async request(method: string, path: string, data?: unknown): Promise<any> {
    const body = data === undefined ? "" : JSON.stringify(data);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`),
      this.merchantKey,
    ).toString("base64");
    let response: globalThis.Response;
    try {
      response = await this.transport("https://api.mch.weixin.qq.com" + path, {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "IdeaNotes/0.2",
          "Wechatpay-Serial": this.config.publicKeyId,
          Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.config.serialNo}",signature="${signature}"`,
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(12000),
        redirect: "error",
      });
    } catch {
      throw new WechatError("NETWORK");
    }
    const raw = await response.text();
    const requestId = response.headers.get("request-id");
    // Trust no payment state or definitive failure until the raw response is authenticated.
    try {
      this.verify(raw, response.headers);
    } catch {
      throw new WechatError("INVALID_SIGNATURE", requestId);
    }
    if (!response.ok) {
      let code = "PROVIDER_ERROR";
      try {
        code = JSON.parse(raw).code || code;
      } catch {}
      throw new WechatError(code, requestId);
    }
    return raw ? JSON.parse(raw) : null;
  }
  async create(order: PaymentOrder, ip: string) {
    const payload = {
      appid: this.config.appId,
      mchid: this.config.mchId,
      description: order.description,
      out_trade_no: order.id,
      time_expire: order.expiresAt.replace(/\.\d{3}Z$/, "+00:00"),
      notify_url: this.config.notifyUrl,
      amount: { total: order.amount, currency: "CNY" },
      ...(order.channel === "h5"
        ? { scene_info: { payer_client_ip: ip, h5_info: { type: "Wap" } } }
        : {}),
    };
    const result = await this.request(
      "POST",
      `/v3/pay/transactions/${order.channel}`,
      payload,
    );
    if (order.channel === "native") {
      const url = z.string().parse(result.code_url);
      if (!url.startsWith("weixin://wxpay/"))
        throw new WechatError("INVALID_PAYMENT_URL");
      return url;
    }
    const url = new URL(z.string().parse(result.h5_url));
    if (url.protocol !== "https:" || url.hostname !== "wx.tenpay.com")
      throw new WechatError("INVALID_PAYMENT_URL");
    return url.href;
  }
  async query(id: string) {
    return paymentSchema.parse(
      await this.request(
        "GET",
        `/v3/pay/transactions/out-trade-no/${encodeURIComponent(id)}?mchid=${encodeURIComponent(this.config.mchId)}`,
      ),
    );
  }
  async close(id: string) {
    await this.request(
      "POST",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(id)}/close`,
      { mchid: this.config.mchId },
    );
  }
  async refund(id: string, refundId: string, amount: number, reason: string) {
    return refundSchema.parse(
      await this.request("POST", "/v3/refund/domestic/refunds", {
        out_trade_no: id,
        out_refund_no: refundId,
        reason,
        notify_url: this.config.refundNotifyUrl,
        amount: { refund: amount, total: amount, currency: "CNY" },
      }),
    );
  }
  async queryRefund(id: string) {
    return refundSchema.parse(
      await this.request(
        "GET",
        `/v3/refund/domestic/refunds/${encodeURIComponent(id)}`,
      ),
    );
  }
  notification(raw: string, headers: Headers) {
    this.verify(raw, headers);
    const envelope = z
      .object({
        id: z.string().min(1).max(128),
        event_type: z.string(),
        resource_type: z.literal("encrypt-resource"),
        resource: z.object({
          algorithm: z.literal("AEAD_AES_256_GCM"),
          original_type: z.string(),
          ciphertext: z.string(),
          nonce: z.string(),
          associated_data: z.string().optional(),
        }),
      })
      .parse(JSON.parse(raw));
    const encrypted = Buffer.from(envelope.resource.ciphertext, "base64");
    if (encrypted.length < 17) throw new WechatError("INVALID_CIPHERTEXT");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(this.config.apiV3Key),
      Buffer.from(envelope.resource.nonce),
    );
    decipher.setAuthTag(encrypted.subarray(-16));
    decipher.setAAD(Buffer.from(envelope.resource.associated_data || ""));
    const data = JSON.parse(
      Buffer.concat([
        decipher.update(encrypted.subarray(0, -16)),
        decipher.final(),
      ]).toString("utf8"),
    );
    return {
      id: envelope.id,
      type: envelope.event_type,
      resourceType: envelope.resource.original_type,
      data,
    };
  }
}
export function wechatFromEnv(env: NodeJS.ProcessEnv) {
  const names = [
    "WECHAT_APP_ID",
    "WECHAT_MCH_ID",
    "WECHAT_SERIAL_NO",
    "WECHAT_PRIVATE_KEY_PATH",
    "WECHAT_PUBLIC_KEY_ID",
    "WECHAT_PUBLIC_KEY_PATH",
    "WECHAT_API_V3_KEY",
    "WECHAT_NOTIFY_URL",
    "WECHAT_REFUND_NOTIFY_URL",
  ];
  const missing = names.filter((key) => !env[key]);
  if (missing.length) return { provider: undefined, missing };
  try {
    return {
      provider: new WechatPay({
        appId: env.WECHAT_APP_ID!,
        mchId: env.WECHAT_MCH_ID!,
        serialNo: env.WECHAT_SERIAL_NO!,
        privateKey: readFileSync(env.WECHAT_PRIVATE_KEY_PATH!, "utf8"),
        publicKeyId: env.WECHAT_PUBLIC_KEY_ID!,
        publicKey: readFileSync(env.WECHAT_PUBLIC_KEY_PATH!, "utf8"),
        apiV3Key: env.WECHAT_API_V3_KEY!,
        notifyUrl: env.WECHAT_NOTIFY_URL!,
        refundNotifyUrl: env.WECHAT_REFUND_NOTIFY_URL!,
        h5Enabled: env.WECHAT_H5_ENABLED === "true",
      }),
      missing: [],
    };
  } catch {
    throw new BusinessError(
      503,
      "PAYMENT_CONFIG",
      "微信支付密钥、证书路径或商户配置无效，请检查本地配置（不会输出密钥）",
    );
  }
}
