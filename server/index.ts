import "dotenv/config";
import express from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { createApp } from "./app";
import { wechatFromEnv } from "./payments/wechat";
import { plansFromEnv } from "./payments/billing";
const env = process.env;
const basePath = env.APP_BASE_PATH || "/";
if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(basePath))
  throw new Error("Invalid APP_BASE_PATH");
const wechat = wechatFromEnv(env);
const { app } = createApp({
  database: env.DATABASE_PATH || "./data/ideas.sqlite",
  production: env.NODE_ENV === "production",
  origin: env.APP_ORIGIN || "http://localhost:5173",
  cookiePath: basePath,
  authMode: env.AUTH_MODE || "development",
  adminEmails: (env.ADMIN_EMAILS || "admin@example.com")
    .split(",")
    .map((s) => s.trim().toLowerCase()),
  dailyLimit: Number(env.AI_DAILY_REQUEST_LIMIT || 200),
  trustProxy: env.TRUSTED_PROXY_CIDRS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  billing: {
    ...wechat,
    plans: plansFromEnv(env),
    enabled: env.PAYMENT_ENABLED === "true",
    allowRefunds: env.PAYMENT_REFUNDS_ENABLED === "true",
    supportEmail: env.PAYMENT_SUPPORT_EMAIL,
    refundPolicyUrl: env.PAYMENT_REFUND_POLICY_URL,
    publicOrigin: env.APP_ORIGIN,
    publicBasePath: basePath,
  },
  ai: {
    mode: env.AI_MODE || "demo",
    baseURL: env.AI_BASE_URL || "https://api.openai.com/v1",
    apiKey: env.AI_API_KEY || "",
    quickModel: env.AI_QUICK_MODEL || "",
    deepModel: env.AI_DEEP_MODEL || "",
    provider: env.AI_PROVIDER_NAME || "",
    policyURL: env.AI_DATA_POLICY_URL || "",
  },
  smtp: {
    host: env.SMTP_HOST || "",
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== "false",
    user: env.SMTP_USER || "",
    pass: env.SMTP_PASS || "",
    from: env.SMTP_FROM || "",
  },
});
if (existsSync(resolve("dist"))) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
app.listen(Number(env.PORT || 3001), env.HOST || "127.0.0.1", () =>
  console.log(
    `Idea Notes API: http://${env.HOST || "127.0.0.1"}:${env.PORT || 3001} · ${env.AI_MODE || "demo"} AI`,
  ),
);
