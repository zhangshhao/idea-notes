import { z } from "zod";
import { summarySchema, now, points, row, rows, uid } from "./domain";
import { transaction, type DB } from "./db";

export interface AIConfig {
  mode: string;
  baseURL: string;
  apiKey: string;
  quickModel: string;
  deepModel: string;
  provider: string;
  policyURL: string;
}
export const proposalSchema = z.object({
  summary: summarySchema,
  actions: z.array(z.string().min(1).max(200)).max(20),
});
export const systemPrompt = `你是个人想法讨论助手。只使用当前想法和当前对话，不编造调研、事实、来源或实时信息。没有联网搜索能力。区分已知、推测、待验证；信息不足时提出一到三个关键问题。不要自动执行行动，不要改变用户原始记录。用简体中文简洁回答。`;
export function createRunner(db: DB, config: AIConfig) {
  const controllers = new Map<string, AbortController>();
  function finish(id: string, state: string, result: any) {
    return transaction(db, () => {
      const r = row(db, "SELECT * FROM requests WHERE id=?", id);
      if (!r || !["running", "reserved"].includes(r.state)) return;
      const data = JSON.parse(r.data);
      const charge =
        ["completed", "stopped"].includes(state) &&
        data.content.trim() &&
        result.usage
          ? Math.min(
              data.maximum,
              points(result.usage.input, result.usage.output, data.mode),
            )
          : 0;
      const merged = { ...data, ...result, charged: charge, finishedAt: now() };
      db.prepare("UPDATE requests SET state=?,data=? WHERE id=?").run(
        state,
        JSON.stringify(merged),
        id,
      );
      if (charge)
        db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)").run(
          uid(),
          r.user_id,
          r.period_id,
          id,
          "consume",
          charge,
          now(),
        );
      db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)").run(
        uid(),
        r.user_id,
        r.period_id,
        id,
        "release",
        data.maximum - charge,
        now(),
      );
      db.prepare(
        "UPDATE messages SET content=? WHERE request_id=? AND role=?",
      ).run(data.content, id, "assistant");
    });
  }
  function append(id: string, chunk: string) {
    const r = row(db, "SELECT data,state FROM requests WHERE id=?", id);
    if (!r || r.state !== "running") return;
    const data = JSON.parse(r.data);
    data.content += chunk;
    db.prepare("UPDATE requests SET data=? WHERE id=?").run(
      JSON.stringify(data),
      id,
    );
    db.prepare(
      "UPDATE messages SET content=? WHERE request_id=? AND role=?",
    ).run(data.content, id, "assistant");
  }
  async function run(id: string) {
    const controller = new AbortController();
    controllers.set(id, controller);
    const timeout = setTimeout(() => controller.abort("timeout"), 120000);
    let usage: { input: number; output: number } | undefined;
    let content = "";
    let finishReason = "";
    try {
      const r = row(db, "SELECT * FROM requests WHERE id=?", id);
      const data = JSON.parse(r.data);
      if (config.mode === "demo") {
        const proposal = {
          summary: {
            current: data.ideaTitle,
            known: `原始记录：${data.ideaBody.slice(0, 280)}`,
            questions:
              "谁最需要这个想法？\n可以用什么小实验验证需求？\n什么结果会让你决定继续？",
          },
          actions: [
            "写下最需要解决的一个具体问题",
            "找一位目标用户聊聊现有做法",
            "设计一个一小时内可以完成的小实验",
          ],
        };
        const response =
          data.kind === "summary"
            ? JSON.stringify(proposal)
            : `这是本地演示回复，未调用真实模型。\n\n关于「${data.ideaTitle}」，可以先把探索范围缩小到一个具体场景。\n\n① 明确问题\n你希望改变谁的哪一个日常瞬间？先用一句话描述现状。\n\n② 找到最小验证\n暂时不用完善整个方案。找一位可能需要它的人，了解对方现在怎么解决。\n\n③ 选择下一步\n记录最不确定的假设，设计一个成本很低的小实验。\n\n你提到「${data.prompt.slice(0, 180)}」。其中最希望先讨论的是哪一部分？`;
        for (let i = 0; i < response.length; i += 12) {
          if (controller.signal.aborted) break;
          const chunk = response.slice(i, i + 12);
          content += chunk;
          append(id, chunk);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        usage = {
          input: Math.ceil(data.contextBytes / 3),
          output: Math.ceil(content.length / 2),
        };
      } else {
        const response = await fetch(
          `${config.baseURL.replace(/\/$/, "")}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: data.model,
              messages: data.context,
              stream: true,
              stream_options: { include_usage: true },
              max_tokens: data.outputLimit,
              ...(data.kind === "summary"
                ? { response_format: { type: "json_object" } }
                : {}),
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok || !response.body) throw new Error("provider");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let refused = false;
        const consume = (line: string) => {
          if (!line.startsWith("data:")) return;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") return;
          const event = JSON.parse(raw);
          if (event.error) throw new Error("provider");
          if (
            event.usage &&
            Number.isFinite(event.usage.prompt_tokens) &&
            Number.isFinite(event.usage.completion_tokens)
          ) {
            const reasoning = Number(
              event.usage.completion_tokens_details?.reasoning_tokens || 0,
            );
            usage = {
              input: event.usage.prompt_tokens,
              output: Math.max(0, event.usage.completion_tokens - reasoning),
            };
          }
          const choice = event.choices?.[0];
          if (
            choice?.delta?.refusal ||
            choice?.finish_reason === "content_filter"
          )
            refused = true;
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const chunk = choice?.delta?.content;
          if (typeof chunk === "string") {
            content += chunk;
            append(id, chunk);
          }
        };
        while (true) {
          const part = await reader.read();
          buffer += decoder.decode(part.value, { stream: !part.done });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) consume(line);
          if (part.done) {
            if (buffer) consume(buffer);
            break;
          }
        }
        if (refused) throw new Error("refused");
        if (!finishReason) throw new Error("incomplete");
      }
      if (controller.signal.aborted) {
        finish(id, controller.signal.reason === "stop" ? "stopped" : "failed", {
          usage,
          error:
            controller.signal.reason === "stop" ? null : "生成超时，额度已释放",
        });
        return;
      }
      if (!content.trim()) throw new Error("empty");
      const proposal =
        data.kind === "summary"
          ? proposalSchema.parse(JSON.parse(content))
          : null;
      finish(id, "completed", {
        usage,
        proposal,
        limited: finishReason === "length",
        note: usage ? null : "供应商未返回可信用量，本次由平台承担，不扣点。",
      });
    } catch (error) {
      const stopped = controller.signal.reason === "stop";
      finish(id, stopped ? "stopped" : "failed", {
        usage: stopped ? usage : undefined,
        error: stopped ? null : "本次生成未完成，额度已释放。请稍后重试。",
      });
    } finally {
      clearTimeout(timeout);
      controllers.delete(id);
    }
  }
  function recover() {
    for (const r of rows(
      db,
      "SELECT id FROM requests WHERE state IN ('running','reserved')",
    ))
      finish(r.id, "failed", {
        error: "服务重新启动，未完成请求的预占额度已释放。",
      });
  }
  return {
    run,
    recover,
    stop: (id: string) => controllers.get(id)?.abort("stop"),
    shutdown: () => {
      for (const c of controllers.values()) c.abort("shutdown");
    },
    finish,
  };
}
