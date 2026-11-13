import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import nodemailer from "nodemailer";
import JSZip from "jszip";
import { z } from "zod";
import { openDatabase, transaction } from "./db";
import {
  assert,
  BusinessError,
  idea,
  ideaSchema,
  markdown,
  now,
  points,
  quota,
  row,
  rows,
  saveIdea,
  uid,
  type IdeaData,
} from "./domain";
import { createRunner, systemPrompt, type AIConfig } from "./ai";
import { createBilling, type BillingConfig } from "./payments/billing";

export interface Config {
  database: string;
  production: boolean;
  origin: string;
  authMode: string;
  adminEmails: string[];
  ai: AIConfig;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
  dailyLimit?: number;
  billing?: BillingConfig;
  trustProxy?: string[];
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const validID = z.string().uuid();
export function createApp(config: Config) {
  if (config.production && config.authMode !== "smtp")
    throw new Error("Production requires SMTP authentication.");
  if (config.production && !config.origin.startsWith("https://"))
    throw new Error("Production requires an HTTPS APP_ORIGIN.");
  if (
    config.ai.mode !== "demo" &&
    (!config.ai.apiKey ||
      !config.ai.quickModel ||
      !config.ai.deepModel ||
      !config.ai.provider ||
      !config.ai.policyURL)
  )
    throw new Error("AI provider configuration is incomplete.");
  const db = openDatabase(config.database);
  if (
    config.billing?.enabled &&
    (config.authMode !== "smtp" ||
      config.ai.mode === "demo" ||
      !config.production)
  )
    throw new Error("启用真实收款前需要生产模式、SMTP 登录和真实 AI 服务。");
  const billing = createBilling(db, config.billing);
  const runner = createRunner(db, config.ai);
  runner.recover();
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy?.length) app.set("trust proxy", config.trustProxy);
  app.use(
    helmet({ contentSecurityPolicy: config.production ? undefined : false }),
  );
  // These two signed third-party endpoints must see untouched bytes, before JSON or CSRF middleware.
  for (const kind of ["payment", "refund"] as const)
    app.post(
      `/api/payments/wechat/${kind === "payment" ? "notify" : "refund-notify"}`,
      express.raw({ type: "application/json", limit: "128kb" }),
      async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try {
          if (!Buffer.isBuffer(req.body)) throw new Error("raw body required");
          const headers = new Headers();
          for (const name of [
            "wechatpay-timestamp",
            "wechatpay-nonce",
            "wechatpay-signature",
            "wechatpay-serial",
          ]) {
            const value = req.get(name);
            if (value) headers.set(name, value);
          }
          await billing.notification(kind, req.body.toString("utf8"), headers);
          res.status(204).end();
        } catch (error) {
          const status =
            error instanceof BusinessError && error.status === 503 ? 503 : 400;
          res
            .status(status)
            .json({ code: "FAIL", message: "通知未确认，请重试" });
        }
      },
    );
  app.use(express.json({ limit: "512kb" }));
  app.use(cookieParser());
  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed =
        origin === config.origin ||
        (!config.production &&
          /^http:\/\/(localhost|127\.0\.0\.1):(5173|3001)$/.test(origin || ""));
      if (req.headers["x-idea-client"] !== "1" || (origin && !allowed)) {
        res
          .status(403)
          .json({ code: "CSRF", message: "请求来源无效，请刷新页面后重试" });
        return;
      }
    }
    const session = req.cookies.idea_session
      ? row(
          db,
          "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
          hash(req.cookies.idea_session),
          Date.now(),
        )
      : null;
    res.locals.user = session;
    next();
  });
  const auth = (_req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.user)
      return next(
        new BusinessError(401, "UNAUTHENTICATED", "请登录后继续，草稿已保留"),
      );
    next();
  };
  const admin = (_req: Request, res: Response, next: NextFunction) => {
    if (!res.locals.user)
      return next(new BusinessError(401, "UNAUTHENTICATED", "请登录后继续"));
    if (!config.adminEmails.includes(res.locals.user.email))
      return next(new BusinessError(403, "FORBIDDEN", "无管理权限"));
    next();
  };
  const user = (res: Response) => res.locals.user.id as string;
  const audit = (actor: string, action: string, data: unknown) =>
    db
      .prepare("INSERT INTO audit VALUES(?,?,?,?,?)")
      .run(uid(), actor, action, JSON.stringify(data), now());
  function rate(key: string, max: number, window: number) {
    const r = row(db, "SELECT * FROM auth_limits WHERE key=?", key);
    const stamp = Date.now();
    if (r && stamp - r.started < window) {
      assert(r.count < max, 429, "RATE_LIMIT", "操作过于频繁，请稍后再试");
      db.prepare("UPDATE auth_limits SET count=count+1 WHERE key=?").run(key);
    } else
      db.prepare("INSERT OR REPLACE INTO auth_limits VALUES(?,?,1)").run(
        key,
        stamp,
      );
  }
  const configPublic = () => ({
    development: config.authMode === "development",
    aiDemo: config.ai.mode === "demo",
    provider:
      config.ai.mode === "demo"
        ? "本地演示（不发送至第三方）"
        : config.ai.provider,
    quickModel: config.ai.mode === "demo" ? "demo-quick" : config.ai.quickModel,
    deepModel: config.ai.mode === "demo" ? "demo-deep" : config.ai.deepModel,
    policyURL: config.ai.policyURL,
    paymentEnabled: billing.status().enabled,
  });
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, version: "0.2.0" }),
  );
  app.get("/api/config", (_req, res) => res.json(configPublic()));
  app.get("/api/me", (_req, res) =>
    res.json({
      user: res.locals.user
        ? {
            id: user(res),
            email: res.locals.user.email,
            aiConsent: !!res.locals.user.ai_consent,
            admin: config.adminEmails.includes(res.locals.user.email),
          }
        : null,
      ...configPublic(),
    }),
  );
  app.post("/api/auth/code", async (req, res) => {
    const { email: raw } = z
      .object({ email: z.email().max(254) })
      .parse(req.body);
    const email = raw.toLowerCase().trim();
    rate(`ip:${req.ip}`, 30, 3600000);
    rate(`email:${email}`, 5, 3600000);
    const old = row(db, "SELECT sent FROM codes WHERE email=?", email);
    assert(
      !old || Date.now() - old.sent >= 60000,
      429,
      "RATE_LIMIT",
      "请等待 60 秒后重新获取",
    );
    const code = String(randomInt(100000, 1000000));
    const stamp = Date.now();
    db.prepare("INSERT OR REPLACE INTO codes VALUES(?,?,?,?,0)").run(
      email,
      hash(`${email}:${code}`),
      stamp + 600000,
      stamp,
    );
    if (config.authMode === "smtp") {
      assert(config.smtp?.host, 503, "MAIL_UNAVAILABLE", "邮件服务尚未配置");
      const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });
      try {
        await transport.sendMail({
          from: config.smtp.from,
          to: email,
          subject: "一念 · 登录验证码",
          text: `你的验证码为 ${code}，10 分钟内有效。如非本人操作，请忽略。`,
        });
      } catch {
        db.prepare("DELETE FROM codes WHERE email=?").run(email);
        throw new BusinessError(
          503,
          "MAIL_UNAVAILABLE",
          "邮件暂时无法发送，请稍后再试",
        );
      }
    }
    res.json({
      ok: true,
      ...(config.authMode === "development" ? { developmentCode: code } : {}),
    });
  });
  app.post("/api/auth/login", (req, res) => {
    const data = z
      .object({
        email: z.email(),
        code: z.string().regex(/^\d{6}$/),
        accepted: z.literal(true),
      })
      .parse(req.body);
    const email = data.email.toLowerCase().trim();
    rate(`verify:${req.ip}`, 60, 3600000);
    const c = row(db, "SELECT * FROM codes WHERE email=?", email);
    assert(
      c && c.expires > Date.now() && c.attempts < 5,
      400,
      "INVALID_CODE",
      "验证码无效或已过期",
    );
    db.prepare("UPDATE codes SET attempts=attempts+1 WHERE email=?").run(email);
    assert(
      timingSafeEqual(
        Buffer.from(c.hash),
        Buffer.from(hash(`${email}:${data.code}`)),
      ),
      400,
      "INVALID_CODE",
      "验证码无效或已过期",
    );
    const token = randomBytes(32).toString("hex");
    transaction(db, () => {
      db.prepare("DELETE FROM codes WHERE email=?").run(email);
      db.prepare("INSERT OR IGNORE INTO users VALUES(?,?,?,?,NULL)").run(
        uid(),
        email,
        now(),
        "2026-11-draft",
      );
      const u = row(db, "SELECT * FROM users WHERE email=?", email);
      db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
        hash(token),
        u.id,
        Date.now() + 30 * 86400000,
      );
    });
    res
      .cookie("idea_session", token, {
        httpOnly: true,
        secure: config.production,
        sameSite: "strict",
        maxAge: 30 * 86400000,
        path: "/",
      })
      .json({ ok: true });
  });
  app.post("/api/auth/logout", auth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token=?").run(
      hash(req.cookies.idea_session),
    );
    res.clearCookie("idea_session", { path: "/" }).json({ ok: true });
  });
  app.post("/api/auth/ai-consent", auth, (_req, res) => {
    db.prepare("UPDATE users SET ai_consent=? WHERE id=?").run(
      now(),
      user(res),
    );
    res.json({ ok: true });
  });
  app.get("/api/ideas", auth, (req, res) => {
    const query = String(req.query.q || "").toLowerCase();
    const view = String(req.query.view || "all");
    const status = String(req.query.status || "");
    const tag = String(req.query.tag || "");
    const all = rows(
      db,
      "SELECT id FROM ideas WHERE user_id=? ORDER BY updated_at DESC",
      user(res),
    ).map((r) => idea(db, r.id, user(res), true));
    const filtered = all.filter(
      (i) =>
        (view === "trash"
          ? !!i.deletedAt
          : !i.deletedAt && (view === "archive" ? i.archived : !i.archived)) &&
        (view !== "favorites" || i.favorite) &&
        (!query ||
          `${i.title} ${i.body} ${Object.values(i.summary).join(" ")}`
            .toLowerCase()
            .includes(query)) &&
        (!status || i.status === status) &&
        (!tag || i.tags.includes(tag)),
    );
    const page = Math.max(0, Number(req.query.page) || 0);
    res.json({
      items: filtered.slice(page * 30, page * 30 + 30),
      total: filtered.length,
      counts: {
        all: all.filter((i) => !i.deletedAt && !i.archived).length,
        favorites: all.filter((i) => !i.deletedAt && !i.archived && i.favorite)
          .length,
        archive: all.filter((i) => !i.deletedAt && i.archived).length,
        trash: all.filter((i) => i.deletedAt).length,
      },
      tags: [
        ...new Set(all.filter((i) => !i.deletedAt).flatMap((i) => i.tags)),
      ],
    });
  });
  app.post("/api/ideas", auth, (req, res) => {
    const id = validID.parse(req.body.id);
    const input = ideaSchema.parse(req.body);
    const result = transaction(db, () => {
      const exists = row(db, "SELECT user_id FROM ideas WHERE id=?", id);
      if (exists) {
        assert(
          exists.user_id === user(res),
          409,
          "ID_CONFLICT",
          "记录标识已使用",
        );
        return idea(db, id, user(res), true);
      }
      assert(
        row(db, "SELECT COUNT(*) n FROM ideas WHERE user_id=?", user(res)).n <
          10000,
        409,
        "CAPACITY",
        "想法容量已达上限，请先清理回收站",
      );
      const data = {
        ...input,
        title:
          input.title.trim() ||
          [...input.body.trim().split("\n")[0]].slice(0, 30).join(""),
        createdAt: now(),
        summaryVersions: [],
        adopted: [],
      };
      db.prepare("INSERT INTO ideas VALUES(?,?,?,?,?,NULL)").run(
        id,
        user(res),
        JSON.stringify(data),
        1,
        now(),
      );
      db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run(
        uid(),
        id,
        1,
        JSON.stringify(data),
        now(),
      );
      return idea(db, id, user(res));
    });
    res.json(result);
  });
  app.get("/api/ideas/:id", auth, (req, res) =>
    res.json(idea(db, String(req.params.id), user(res), true)),
  );
  app.put("/api/ideas/:id", auth, (req, res) => {
    const input = ideaSchema.parse(req.body);
    const version = z.number().int().positive().parse(req.body.version);
    const mutation = validID.parse(req.body.mutationId);
    const result = transaction(db, () => {
      const previous = row(
        db,
        "SELECT response,idea_id FROM mutations WHERE user_id=? AND key=?",
        user(res),
        mutation,
      );
      if (previous) {
        assert(
          previous.idea_id === req.params.id,
          409,
          "ID_CONFLICT",
          "同步标识已使用",
        );
        return JSON.parse(previous.response);
      }
      const old = idea(db, String(req.params.id), user(res));
      if (old.version !== version)
        throw new BusinessError(
          409,
          "VERSION_CONFLICT",
          "其他设备已更新，请比较后保存",
          old,
        );
      const data: IdeaData = {
        ...old,
        ...input,
        title:
          input.title.trim() ||
          [...input.body.trim().split("\n")[0]].slice(0, 30).join(""),
      };
      if (JSON.stringify(old.summary) !== JSON.stringify(input.summary))
        data.summaryVersions = [
          ...old.summaryVersions,
          { version: old.version, summary: old.summary, at: now() },
        ].slice(-20);
      const saved = saveIdea(db, old.id, user(res), data, old.version + 1);
      db.prepare("INSERT INTO mutations VALUES(?,?,?,?)").run(
        user(res),
        mutation,
        old.id,
        JSON.stringify(saved),
      );
      return saved;
    });
    res.json(result);
  });
  app.get("/api/ideas/:id/revisions", auth, (req, res) => {
    idea(db, String(req.params.id), user(res), true);
    res.json(
      rows(
        db,
        "SELECT version,data,created_at FROM revisions WHERE idea_id=? ORDER BY version DESC",
        String(req.params.id),
      ).map((r) => ({ ...r, data: JSON.parse(r.data) })),
    );
  });
  app.post("/api/ideas/:id/trash", auth, (req, res) => {
    const result = transaction(db, () => {
      const old = idea(db, String(req.params.id), user(res), true);
      assert(
        !row(
          db,
          "SELECT id FROM requests WHERE idea_id=? AND state='running'",
          old.id,
        ),
        409,
        "TASK_RUNNING",
        "请先停止正在生成的回复",
      );
      assert(
        old.version === req.body.version,
        409,
        "VERSION_CONFLICT",
        "内容已更新，请刷新后操作",
      );
      return saveIdea(
        db,
        old.id,
        user(res),
        old,
        old.version + 1,
        req.body.restore ? null : now(),
      );
    });
    res.json(result);
  });
  function purge(id: string, owner: string) {
    // Retain only minimal accounting metadata; erase prompts, messages and generated content.
    for (const r of rows(
      db,
      "SELECT id,data FROM requests WHERE idea_id=? AND user_id=?",
      id,
      owner,
    )) {
      const d = JSON.parse(r.data);
      db.prepare("UPDATE requests SET data=? WHERE id=?").run(
        JSON.stringify({
          charged: d.charged,
          maximum: d.maximum,
          mode: d.mode,
          model: d.model,
          usage: d.usage,
          finishedAt: d.finishedAt,
        }),
        r.id,
      );
    }
    db.prepare("DELETE FROM ideas WHERE id=? AND user_id=?").run(id, owner);
  }
  app.delete("/api/ideas/:id", auth, (req, res) => {
    transaction(db, () => {
      const old = idea(db, String(req.params.id), user(res), true);
      assert(
        old.deletedAt && req.body.confirm === true,
        400,
        "CONFIRM_REQUIRED",
        "请在回收站确认永久删除",
      );
      purge(old.id, user(res));
    });
    res.json({ ok: true });
  });
  app.get("/api/ideas/:id/messages", auth, (req, res) => {
    idea(db, String(req.params.id), user(res), true);
    res.json(
      rows(
        db,
        "SELECT m.*,r.state,r.data request_data FROM messages m LEFT JOIN requests r ON m.request_id=r.id WHERE m.idea_id=? AND m.user_id=? ORDER BY m.rowid",
        String(req.params.id),
        user(res),
      ).map((m) => {
        const d = m.request_data ? JSON.parse(m.request_data) : {};
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          requestId: m.request_id,
          state: m.state,
          charged: d.charged,
          error: d.error,
          kind: d.kind,
          proposal: d.dismissed ? undefined : d.proposal,
          baseVersion: d.baseVersion,
          note: d.note,
          limited: d.limited,
        };
      }),
    );
  });
  app.post("/api/requests/:id/dismiss", auth, (req, res) => {
    const r = row(
      db,
      "SELECT data FROM requests WHERE id=? AND user_id=?",
      String(req.params.id),
      user(res),
    );
    assert(r, 404, "NOT_FOUND", "找不到请求");
    const d = JSON.parse(r.data);
    assert(d.proposal, 400, "INVALID_PROPOSAL", "该请求没有整理提议");
    db.prepare("UPDATE requests SET data=? WHERE id=?").run(
      JSON.stringify({ ...d, dismissed: true }),
      String(req.params.id),
    );
    res.json({ ok: true });
  });
  app.get("/api/quota", auth, (_req, res) => res.json(quota(db, user(res))));
  app.get("/api/ledger", auth, (_req, res) =>
    res.json(
      rows(
        db,
        "SELECT id,request_id requestId,kind,amount,created_at createdAt FROM ledger WHERE user_id=? ORDER BY rowid DESC LIMIT 200",
        user(res),
      ),
    ),
  );
  app.get("/api/requests/active", auth, (_req, res) => {
    const r = row(
      db,
      "SELECT id,idea_id ideaId FROM requests WHERE user_id=? AND state='running'",
      user(res),
    );
    res.json(r || null);
  });
  app.post("/api/ideas/:id/quote", auth, (req, res) => {
    const input = z
      .object({
        prompt: z
          .string()
          .min(1)
          .refine((v) => [...v].length <= 8000, "消息最多 8000 字"),
        mode: z.enum(["quick", "deep"]),
        kind: z.enum(["chat", "summary"]),
        outputLimit: z.union([
          z.literal(256),
          z.literal(512),
          z.literal(1024),
          z.literal(2048),
          z.literal(4096),
        ]),
      })
      .parse(req.body);
    const i = idea(db, String(req.params.id), user(res));
    const q = quota(db, user(res));
    assert(
      input.mode === "quick" || q.plan !== "free",
      403,
      "PLAN_REQUIRED",
      "深度分析需要有效的付费套餐，请前往订阅与额度查看",
    );
    assert(
      input.outputLimit <= (input.mode === "quick" ? 2048 : 4096),
      400,
      "OUTPUT_LIMIT",
      "所选输出上限不可用",
    );
    assert(
      res.locals.user.ai_consent,
      409,
      "AI_CONSENT",
      "首次讨论前，请确认模型与数据说明",
    );
    assert(
      row(db, "SELECT value FROM settings WHERE key='ai_paused'")?.value !==
        "true",
      503,
      "AI_PAUSED",
      "AI 服务暂时维护中，记录和导出仍可使用",
    );
    const history = rows(
      db,
      "SELECT m.role,m.content FROM messages m JOIN requests r ON m.request_id=r.id WHERE m.idea_id=? AND r.state IN ('completed','stopped') ORDER BY m.rowid",
      i.id,
    );
    const context: any[] = [
      {
        role: "system",
        content:
          systemPrompt +
          (input.kind === "summary"
            ? '\n输出 JSON 对象，结构为 {"summary":{"current":"当前想法","known":"已经明确的内容","questions":"待验证的问题"},"actions":["候选行动"]}。不输出代码围栏。'
            : ""),
      },
      {
        role: "user",
        content: `原始记录：\n${i.body}\n用户已确认整理：\n${JSON.stringify(i.summary)}`,
      },
    ];
    // Conservative UTF-8 byte bound; never silently omit the current question or original note.
    const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
    const last = { role: "user", content: input.prompt };
    assert(
      size([...context, last]) < 15500,
      400,
      "CONTEXT_TOO_LONG",
      "当前记录与问题超出上下文预算，请缩短后再讨论；完整内容仍会保留",
    );
    const retained: any[] = [];
    for (let n = history.length - 2; n >= 0; n -= 2) {
      const pair = history.slice(n, n + 2);
      if (size([...context, ...pair, ...retained, last]) > 15500) break;
      retained.unshift(...pair);
    }
    context.push(...retained, last);
    const contextBytes = size(context) + 256;
    const maximum = points(contextBytes, input.outputLimit, input.mode);
    const data = {
      ...input,
      ideaTitle: i.title,
      ideaBody: i.body,
      baseVersion: i.version,
      context,
      contextBytes,
      maximum,
      model:
        input.mode === "quick" ? config.ai.quickModel : config.ai.deepModel,
      rateVersion: "demo-v1",
      truncated: retained.length < history.length,
    };
    const id = uid();
    db.prepare("INSERT INTO quotes VALUES(?,?,?,?,?)").run(
      id,
      user(res),
      i.id,
      JSON.stringify(data),
      Date.now() + 300000,
    );
    res.json({
      id,
      maximum,
      available: q.available,
      truncated: data.truncated,
      expiresAt: Date.now() + 300000,
    });
  });
  app.post("/api/ideas/:id/requests", auth, (req, res) => {
    const input = z.object({ id: validID, quoteId: validID }).parse(req.body);
    const result = transaction(db, () => {
      const existing = row(db, "SELECT * FROM requests WHERE id=?", input.id);
      if (existing) {
        assert(
          existing.user_id === user(res) && existing.idea_id === req.params.id,
          409,
          "ID_CONFLICT",
          "请求标识已使用",
        );
        return { id: existing.id, reused: true };
      }
      const i = idea(db, String(req.params.id), user(res));
      const quote = row(
        db,
        "SELECT * FROM quotes WHERE id=? AND user_id=? AND idea_id=?",
        input.quoteId,
        user(res),
        i.id,
      );
      assert(
        quote && quote.expires > Date.now(),
        409,
        "QUOTE_EXPIRED",
        "额度估算已过期，请重新确认",
      );
      const data = JSON.parse(quote.data);
      assert(
        data.baseVersion === i.version,
        409,
        "VERSION_CONFLICT",
        "记录已更新，请重新估算后发送",
      );
      assert(
        res.locals.user.ai_consent,
        409,
        "AI_CONSENT",
        "请先确认模型与数据说明",
      );
      assert(
        row(db, "SELECT value FROM settings WHERE key='ai_paused'")?.value !==
          "true",
        503,
        "AI_PAUSED",
        "AI 服务暂时维护中",
      );
      const q = quota(db, user(res));
      assert(
        data.mode === "quick" || q.plan !== "free",
        403,
        "PLAN_REQUIRED",
        "当前套餐不支持深度分析",
      );
      assert(
        !row(
          db,
          "SELECT id FROM requests WHERE user_id=? AND state='running'",
          user(res),
        ),
        409,
        "TASK_RUNNING",
        "已有 AI 任务正在运行，请等待或停止后重试",
      );
      assert(
        q.available >= data.maximum,
        409,
        "QUOTA_EXCEEDED",
        `本次最多需要 ${data.maximum} 点，当前可用 ${q.available} 点。可降低输出上限后重新估算`,
      );
      rate(`ai:${user(res)}`, 6, 60000);
      assert(
        row(
          db,
          "SELECT COUNT(*) n FROM requests WHERE created_at>=?",
          now().slice(0, 10),
        ).n < (config.dailyLimit || 200),
        503,
        "DAILY_BUDGET",
        "今日平台调用保护线已触发，请稍后再试",
      );
      db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?)").run(
        input.id,
        user(res),
        i.id,
        q.id,
        "running",
        JSON.stringify({
          ...data,
          content: "",
          demo: config.ai.mode === "demo",
        }),
        now(),
      );
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)").run(
        uid(),
        user(res),
        q.id,
        input.id,
        "reserve",
        data.maximum,
        now(),
      );
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
        uid(),
        i.id,
        user(res),
        "user",
        data.prompt,
        input.id,
        now(),
      );
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
        uid(),
        i.id,
        user(res),
        "assistant",
        "",
        input.id,
        now(),
      );
      db.prepare("UPDATE ideas SET updated_at=? WHERE id=?").run(now(), i.id);
      return { id: input.id, reused: false };
    });
    res.json(result);
    if (!result.reused) void runner.run(result.id);
  });
  app.get("/api/requests/:id", auth, (req, res) => {
    const r = row(
      db,
      "SELECT * FROM requests WHERE id=? AND user_id=?",
      String(req.params.id),
      user(res),
    );
    assert(r, 404, "NOT_FOUND", "找不到请求");
    const d = JSON.parse(r.data);
    res.json({
      id: r.id,
      ideaId: r.idea_id,
      state: r.state,
      content: d.content,
      charged: d.charged,
      error: d.error,
    });
  });
  app.post("/api/requests/:id/stop", auth, (req, res) => {
    const r = row(
      db,
      "SELECT id FROM requests WHERE id=? AND user_id=?",
      String(req.params.id),
      user(res),
    );
    assert(r, 404, "NOT_FOUND", "找不到请求");
    runner.stop(r.id);
    res.json({ ok: true });
  });
  app.post("/api/ideas/:id/adopt", auth, (req, res) => {
    const input = z
      .object({
        requestId: validID,
        version: z.number().int(),
        summary: z.boolean(),
        actions: z.array(z.number().int().nonnegative()).max(20),
      })
      .parse(req.body);
    const result = transaction(db, () => {
      const i = idea(db, String(req.params.id), user(res));
      if (i.adopted.includes(input.requestId)) return i;
      const r = row(
        db,
        "SELECT data FROM requests WHERE id=? AND user_id=? AND idea_id=? AND state='completed'",
        input.requestId,
        user(res),
        i.id,
      );
      assert(r, 404, "NOT_FOUND", "找不到有效提议");
      const d = JSON.parse(r.data);
      assert(d.proposal, 400, "INVALID_PROPOSAL", "该回复没有可采纳的整理");
      if (d.baseVersion !== i.version || input.version !== i.version)
        throw new BusinessError(
          409,
          "STALE_PROPOSAL",
          "生成后记录已变化，请手动比较提议并编辑整理，或重新生成",
          i,
        );
      const actions = [...new Set(input.actions)].map((n) => {
        assert(d.proposal.actions[n], 400, "INVALID_ACTION", "候选行动无效");
        return {
          id: uid(),
          text: d.proposal.actions[n],
          done: false,
          source: input.requestId,
        };
      });
      assert(
        i.actions.filter((a: any) => !a.done).length + actions.length <= 20,
        400,
        "ACTION_LIMIT",
        "未完成行动最多 20 项",
      );
      const updated = {
        ...i,
        actions: [...i.actions, ...actions],
        adopted: [...i.adopted, input.requestId],
      };
      if (input.summary) {
        updated.summaryVersions = [
          ...i.summaryVersions,
          {
            version: i.version,
            summary: i.summary,
            at: now(),
            source: input.requestId,
          },
        ].slice(-20);
        updated.summary = d.proposal.summary;
      }
      return saveIdea(db, i.id, user(res), updated, i.version + 1);
    });
    res.json(result);
  });
  app.get("/api/ideas/:id/export", auth, (req, res) => {
    const i = idea(db, String(req.params.id), user(res), true);
    const messages =
      req.query.chat === "true"
        ? rows(
            db,
            "SELECT * FROM messages WHERE idea_id=? ORDER BY rowid",
            i.id,
          )
        : [];
    res
      .type("text/markdown")
      .setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(i.title + ".md")}`,
      );
    res.send(markdown(i, messages));
  });
  app.get("/api/export", auth, async (req, res) => {
    const all = rows(
      db,
      "SELECT id FROM ideas WHERE user_id=?" +
        (req.query.trash === "true" ? "" : " AND deleted_at IS NULL"),
      user(res),
    ).map((r) => idea(db, r.id, user(res), true));
    const zip = new JSZip();
    const records = all.map((i) => ({
      ...i,
      messages:
        req.query.chat === "true"
          ? rows(
              db,
              "SELECT role,content,created_at FROM messages WHERE idea_id=? ORDER BY rowid",
              i.id,
            )
          : [],
    }));
    for (const i of records) zip.file(`${i.id}.md`, markdown(i, i.messages));
    zip.file(
      "data.json",
      JSON.stringify(
        { formatVersion: 1, exportedAt: now(), ideas: records },
        null,
        2,
      ),
    );
    res
      .type("application/zip")
      .setHeader(
        "Content-Disposition",
        'attachment; filename="idea-notes.zip"',
      );
    res.send(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
    );
  });
  app.get("/api/billing", (_req, res) => res.json(billing.status()));
  app.get("/api/orders", auth, (_req, res) =>
    res.json({
      items: billing.list(user(res)),
      enabled: billing.status().enabled,
    }),
  );
  app.post("/api/orders", auth, async (req, res) => {
    rate(`payment:${user(res)}`, 10, 60000);
    const input = z
      .object({
        planVersion: z.string().regex(/^[a-f0-9]{24}$/),
        key: z.string().uuid(),
        channel: z.enum(["native", "h5"]),
        accepted: z.literal(true),
      })
      .strict()
      .parse(req.body);
    res.json(
      await billing.checkout(
        user(res),
        input,
        (req.ip || "").replace(/^::ffff:/, ""),
      ),
    );
  });
  app.get("/api/orders/:id", auth, (req, res) =>
    res.json(
      billing.publicOrder(billing.get(String(req.params.id), user(res))),
    ),
  );
  app.post("/api/orders/:id/refresh", auth, async (req, res) => {
    billing.get(String(req.params.id), user(res));
    rate(`payment-query:${user(res)}`, 30, 60000);
    res.json(await billing.reconcile(String(req.params.id)));
  });
  app.post("/api/orders/:id/close", auth, async (req, res) => {
    rate(`payment-close:${user(res)}`, 10, 60000);
    res.json(await billing.close(String(req.params.id), user(res)));
  });
  app.post("/api/orders/:id/pay", auth, async (req, res) => {
    rate(`payment:${user(res)}`, 10, 60000);
    const o = billing.get(String(req.params.id), user(res));
    res.json(
      await billing.checkout(
        user(res),
        { key: o.client_key, planVersion: o.plan_version, channel: o.channel },
        (req.ip || "").replace(/^::ffff:/, ""),
      ),
    );
  });
  app.post("/api/orders/:id/support", auth, (req, res) => {
    rate(`payment-support:${user(res)}`, 5, 60000);
    const input = z
      .object({ reason: z.string().trim().min(3).max(500) })
      .parse(req.body);
    res.json(billing.support(String(req.params.id), user(res), input.reason));
  });
  app.get("/api/admin/payments", admin, (_req, res) => {
    audit(user(res), "payment.admin_view", {});
    res.json({ items: billing.adminList(), config: billing.status() });
  });
  app.post("/api/admin/payments/:id/refresh", admin, async (req, res) => {
    rate(`admin-pay-query:${user(res)}`, 30, 60000);
    res.json(await billing.reconcile(String(req.params.id)));
  });
  app.post("/api/admin/payments/:id/refund", admin, async (req, res) => {
    rate(`admin-refund:${user(res)}`, 5, 60000);
    const input = z
      .object({
        reason: z.string().trim().min(3).max(80),
        confirm: z.literal(true),
      })
      .parse(req.body);
    res.json(
      await billing.refund(String(req.params.id), user(res), input.reason),
    );
  });
  app.post("/api/account/delete", auth, (req, res) => {
    const code = z
      .string()
      .regex(/^\d{6}$/)
      .parse(req.body.code);
    const u = res.locals.user;
    assert(
      !row(db, "SELECT id FROM payment_orders WHERE user_id=? LIMIT 1", u.id),
      409,
      "PAYMENT_HISTORY",
      "此账号存在支付订单，请先通过订单支持入口处理服务期、退款与交易记录保留，再办理注销。",
    );
    const c = row(db, "SELECT * FROM codes WHERE email=?", u.email);
    assert(
      c && c.expires > Date.now() && c.attempts < 5,
      400,
      "INVALID_CODE",
      "请重新获取验证码",
    );
    db.prepare("UPDATE codes SET attempts=attempts+1 WHERE email=?").run(
      u.email,
    );
    assert(
      timingSafeEqual(
        Buffer.from(c.hash),
        Buffer.from(hash(`${u.email}:${code}`)),
      ),
      400,
      "INVALID_CODE",
      "验证码无效",
    );
    assert(
      !row(
        db,
        "SELECT id FROM requests WHERE user_id=? AND state='running'",
        u.id,
      ),
      409,
      "TASK_RUNNING",
      "请先停止 AI 任务",
    );
    transaction(db, () => {
      db.prepare("DELETE FROM codes WHERE email=?").run(u.email);
      db.prepare("DELETE FROM ledger WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM requests WHERE user_id=?").run(u.id);
      db.prepare("DELETE FROM users WHERE id=?").run(u.id);
    });
    res.clearCookie("idea_session", { path: "/" }).json({ ok: true });
  });
  app.get("/api/admin", admin, (_req, res) => {
    audit(user(res), "admin.overview", {});
    res.json({
      users: rows(
        db,
        "SELECT u.id,u.email,u.created_at createdAt,(SELECT COUNT(*) FROM ideas i WHERE i.user_id=u.id) ideas FROM users u ORDER BY u.created_at DESC LIMIT 100",
      ),
      requests: rows(
        db,
        "SELECT id,state,created_at createdAt,data FROM requests ORDER BY created_at DESC LIMIT 100",
      ).map((r) => {
        const d = JSON.parse(r.data);
        return {
          id: r.id,
          state: r.state,
          createdAt: r.createdAt,
          mode: d.mode,
          charged: d.charged,
          maximum: d.maximum,
          model: d.model,
        };
      }),
      audit: rows(db, "SELECT * FROM audit ORDER BY created_at DESC LIMIT 50"),
      aiPaused:
        row(db, "SELECT value FROM settings WHERE key='ai_paused'")?.value ===
        "true",
      config: configPublic(),
    });
  });
  app.post("/api/admin/ai-paused", admin, (req, res) => {
    const data = z
      .object({ paused: z.boolean(), reason: z.string().min(3).max(200) })
      .parse(req.body);
    transaction(db, () => {
      db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(
        "ai_paused",
        String(data.paused),
      );
      audit(user(res), "ai.pause", data);
    });
    res.json({ ok: true });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ code: "NOT_FOUND", message: "接口不存在" }),
  );
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        code: "VALIDATION",
        message: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("；"),
      });
      return;
    }
    if (error instanceof BusinessError) {
      res.status(error.status).json({
        code: error.code,
        message: error.message,
        details: error.details,
      });
      return;
    }
    if (error.type === "entity.parse.failed") {
      res.status(400).json({ code: "INVALID_JSON", message: "请求格式不正确" });
      return;
    }
    console.error("[server]", error.code || error.name);
    res.status(500).json({
      code: "INTERNAL",
      message: "服务暂时无法处理，请保留草稿后重试",
    });
  });
  const maintenance = setInterval(() => {
    transaction(db, () => {
      for (const r of rows(
        db,
        "SELECT id,user_id FROM ideas WHERE deleted_at IS NOT NULL AND deleted_at<?",
        new Date(Date.now() - 30 * 86400000).toISOString(),
      ))
        purge(r.id, r.user_id);
      db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
      db.prepare("DELETE FROM quotes WHERE expires<?").run(Date.now());
      db.prepare("DELETE FROM auth_limits WHERE started<?").run(
        Date.now() - 86400000,
      );
    });
  }, 60000);
  maintenance.unref();
  const paymentMaintenance = setInterval(() => {
    void billing
      .tick()
      .catch(() => console.error("[payment] reconciliation deferred"));
  }, 30000);
  paymentMaintenance.unref();
  return {
    app,
    db,
    runner,
    billing,
    close: () => {
      clearInterval(maintenance);
      clearInterval(paymentMaintenance);
      runner.shutdown();
    },
  };
}
