import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
const chars = (max: number) =>
  z.string().refine((v) => [...v].length <= max, `最多 ${max} 个字符`);
export const summarySchema = z.object({
  current: chars(12000),
  known: chars(12000),
  questions: chars(12000),
});
export const actionSchema = z.object({
  id: z.string().uuid(),
  text: chars(200).refine((v) => !!v.trim(), "行动不能为空"),
  done: z.boolean(),
  source: z.string().optional(),
});
export const ideaSchema = z.object({
  title: chars(80),
  body: chars(20000).refine((v) => !!v.trim(), "请先写下一点想法"),
  tags: z
    .array(
      chars(20)
        .transform((v) => v.trim())
        .refine(Boolean, "标签不能为空"),
    )
    .max(5)
    .transform((v) => [...new Set(v)]),
  status: z.enum(["待梳理", "推进中", "暂缓", "已完成"]),
  favorite: z.boolean(),
  archived: z.boolean(),
  summary: summarySchema,
  actions: z
    .array(actionSchema)
    .max(1000)
    .refine(
      (v) => v.filter((a) => !a.done).length <= 20,
      "最多保留 20 个未完成行动",
    ),
  mode: z.enum(["quick", "deep"]).default("quick"),
});
export type IdeaData = z.infer<typeof ideaSchema> & {
  createdAt: string;
  summaryVersions: {
    version: number;
    summary: z.infer<typeof summarySchema>;
    at: string;
    source?: string;
  }[];
  adopted: string[];
};
export class BusinessError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function assert(
  value: unknown,
  status: number,
  code: string,
  message: string,
): asserts value {
  if (!value) throw new BusinessError(status, code, message);
}
export function row(db: DB, sql: string, ...params: any[]): any {
  return db.prepare(sql).get(...params);
}
export function rows(db: DB, sql: string, ...params: any[]): any[] {
  return db.prepare(sql).all(...params);
}
export function idea(
  db: DB,
  id: string,
  user: string,
  includeDeleted = false,
): any {
  const record = row(
    db,
    "SELECT * FROM ideas WHERE id=? AND user_id=?",
    id,
    user,
  );
  assert(record, 404, "NOT_FOUND", "找不到这条想法");
  const result = {
    ...JSON.parse(record.data),
    id: record.id,
    version: record.version,
    updatedAt: record.updated_at,
    deletedAt: record.deleted_at,
  };
  if (!includeDeleted && record.deleted_at)
    throw new BusinessError(
      409,
      "DELETED",
      "这条想法已在其他设备删除，请保留本地内容或另存为新想法",
      result,
    );
  return result;
}
export function saveIdea(
  db: DB,
  id: string,
  user: string,
  data: IdeaData,
  version: number,
  deleted: string | null = null,
) {
  const stamp = now();
  db.prepare(
    "UPDATE ideas SET data=?,version=?,updated_at=?,deleted_at=? WHERE id=? AND user_id=?",
  ).run(JSON.stringify(data), version, stamp, deleted, id, user);
  db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?)").run(
    uid(),
    id,
    version,
    JSON.stringify(data),
    stamp,
  );
  db.prepare(
    "DELETE FROM revisions WHERE idea_id=? AND id NOT IN (SELECT id FROM revisions WHERE idea_id=? ORDER BY version DESC LIMIT 20)",
  ).run(id, id);
  return idea(db, id, user, true);
}
export function monthBounds(date = new Date()) {
  const local = new Date(date.getTime() + 8 * 3600000);
  const y = local.getUTCFullYear(),
    m = local.getUTCMonth();
  return {
    starts: new Date(Date.UTC(y, m, 1) - 8 * 3600000).toISOString(),
    ends: new Date(Date.UTC(y, m + 1, 1) - 8 * 3600000).toISOString(),
  };
}
export function quota(db: DB, user: string, at = new Date()) {
  const bounds = monthBounds(at);
  const paid = row(
    db,
    "SELECT s.period_id FROM subscriptions s WHERE s.user_id=? AND s.state='active' AND s.starts<=? AND s.ends>? ORDER BY s.starts DESC LIMIT 1",
    user,
    at.toISOString(),
    at.toISOString(),
  );
  const id = paid?.period_id || `${user}:${bounds.starts}`;
  if (!paid)
    db.prepare("INSERT OR IGNORE INTO periods VALUES(?,?,?,?,?,?)").run(
      id,
      user,
      bounds.starts,
      bounds.ends,
      "free",
      60,
    );
  const p = row(db, "SELECT * FROM periods WHERE id=?", id);
  db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)").run(
    `grant:${id}`,
    user,
    id,
    `grant:${id}`,
    "grant",
    p.total,
    at.toISOString(),
  );
  const totals = rows(
    db,
    "SELECT kind,SUM(amount) amount FROM ledger WHERE period_id=? GROUP BY kind",
    id,
  );
  const get = (kind: string) =>
    Number(totals.find((t) => t.kind === kind)?.amount || 0);
  const used = get("consume");
  const reserved = get("reserve") - get("release") - used;
  return {
    ...p,
    used,
    reserved,
    available: Math.max(0, p.total - used - reserved - get("revoke")),
    resetAt: p.ends,
    nextPeriod:
      row(
        db,
        "SELECT s.starts startsAt,s.ends endsAt,p.plan,p.total FROM subscriptions s JOIN periods p ON s.period_id=p.id WHERE s.user_id=? AND s.state='active' AND s.starts>? ORDER BY s.starts LIMIT 1",
        user,
        at.toISOString(),
      ) || null,
  };
}
export function points(input: number, output: number, mode = "quick") {
  return Math.max(
    1,
    Math.ceil(
      (input / 1000) * (mode === "deep" ? 4 : 1) +
        (output / 1000) * (mode === "deep" ? 16 : 4),
    ),
  );
}
export function markdown(item: any, messages: any[] = []) {
  return `# ${item.title}\n\n状态：${item.status} · 标签：${item.tags.join("、")}\n\n想法 ID：${item.id}\n创建：${item.createdAt}\n更新：${item.updatedAt}\n\n## 原始记录\n\n${item.body}\n\n## 已确认整理\n\n### 当前想法\n${item.summary.current}\n\n### 已经明确\n${item.summary.known}\n\n### 待验证\n${item.summary.questions}\n\n## 行动清单\n\n${item.actions.map((a: any) => `- [${a.done ? "x" : " "}] ${a.text}`).join("\n")}\n${messages.length ? "\n## 讨论记录\n\n" + messages.map((m) => `### ${m.role === "user" ? "我" : "AI"} · ${m.created_at}\n\n${m.content}`).join("\n\n") : ""}`;
}
