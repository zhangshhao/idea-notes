import { openDB } from "idb";
import type { Idea } from "./types";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Idea-Client": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.code, data.message, data.details);
  return data;
}
const database = openDB("idea-notes-private", 1, {
  upgrade(db) {
    db.createObjectStore("cache");
    db.createObjectStore("drafts");
    db.createObjectStore("preferences");
  },
});
export type Draft = { idea: Idea; mutationId: string; dirty: boolean };
export const storage = {
  async draft(owner: string, id: string, value?: Draft) {
    const db = await database;
    const key = `${owner}:${id}`;
    if (value) await db.put("drafts", value, key);
    else return db.get("drafts", key) as Promise<Draft | undefined>;
  },
  async drafts(owner: string) {
    const db = await database;
    const keys = await db.getAllKeys("drafts");
    const values: Draft[] = [];
    for (const k of keys)
      if (String(k).startsWith(owner + ":"))
        values.push(await db.get("drafts", k));
    return values;
  },
  async removeDraft(owner: string, id: string) {
    await (await database).delete("drafts", `${owner}:${id}`);
  },
  async cache(owner: string, idea: Idea) {
    if ((await this.preference(`offline:${owner}`)) === false) return;
    const db = await database;
    await db.put(
      "cache",
      { ...idea, cachedAt: Date.now() },
      `${owner}:${idea.id}`,
    );
    const entries = (await this.cached(owner)).sort(
      (a: any, b: any) => b.cachedAt - a.cachedAt,
    );
    for (const old of entries.slice(20))
      await db.delete("cache", `${owner}:${old.id}`);
  },
  async cached(owner: string): Promise<Idea[]> {
    const db = await database;
    const keys = await db.getAllKeys("cache");
    const values = [];
    for (const key of keys)
      if (String(key).startsWith(owner + ":"))
        values.push(await db.get("cache", key));
    return values;
  },
  async clearCache(owner: string) {
    const db = await database;
    for (const key of await db.getAllKeys("cache"))
      if (String(key).startsWith(owner + ":")) await db.delete("cache", key);
  },
  async clear(owner: string) {
    await this.clearCache(owner);
    const db = await database;
    for (const key of await db.getAllKeys("drafts"))
      if (String(key).startsWith(owner + ":")) await db.delete("drafts", key);
    for (const key of await db.getAllKeys("preferences"))
      if (String(key).startsWith(`chat:${owner}:`))
        await db.delete("preferences", key);
  },
  async preference(key: string, value?: any) {
    const db = await database;
    if (value !== undefined) await db.put("preferences", value, key);
    else return db.get("preferences", key);
  },
};
export function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const displayDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(
    new Date(value),
  );
export const fullDate = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(new Date(value));
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "操作失败，请重试";
