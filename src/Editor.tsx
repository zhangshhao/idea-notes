import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  Cloud,
  CloudOff,
  FileText,
  History,
  Leaf,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError, download, errorText, fullDate, storage } from "./lib";
import { Modal, Spinner } from "./ui";
import {
  blankIdea,
  statuses,
  type Config,
  type Idea,
  type Message,
  type User,
} from "./types";
export type EditorHandle = { flush: () => Promise<boolean> };
type Props = {
  initial: Idea;
  user: User | null;
  config: Config;
  online: boolean;
  onSaved: (i: Idea) => Promise<void>;
  onBack: () => void;
  onLogin: () => void;
  notify: (s: string) => void;
  refreshQuota: () => void;
  onConsent: () => void;
};
export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  {
    initial,
    user,
    config,
    online,
    onSaved,
    onBack,
    onLogin,
    notify,
    refreshQuota,
    onConsent,
  },
  ref,
) {
  const [draft, setDraft] = useState<Idea>(initial);
  const [tab, setTab] = useState<"record" | "chat" | "summary">("record");
  const [counter, setCounter] = useState(0);
  const [saveStatus, setSaveStatus] = useState(
    initial.version ? "已保存到服务端" : "尚未保存",
  );
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<Idea | null>(null);
  const [ready, setReady] = useState(false);
  const [tagsText, setTagsText] = useState(initial.tags.join("，"));
  const [more, setMore] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  const [summaryHistory, setSummaryHistory] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [includeChat, setIncludeChat] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatError, setChatError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [outputLimit, setOutputLimit] = useState(1024);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [consent, setConsent] = useState(false);
  const [consented, setConsented] = useState(!!user?.aiConsent);
  const [modelInfo, setModelInfo] = useState(false);
  const [action, setAction] = useState("");
  const [adoptSummary, setAdoptSummary] = useState(false);
  const [selectedActions, setSelectedActions] = useState<number[]>([]);
  const [hasNew, setHasNew] = useState(false);
  const current = useRef(draft);
  const mutation = useRef<string>(crypto.randomUUID());
  const dirty = useRef(!initial.version && !!initial.body.trim());
  const saving = useRef<Promise<boolean> | null>(null);
  const loaded = useRef(false);
  const conflictRef = useRef<Idea | null>(null);
  const owner = user?.id || "guest";
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const mounted = useRef(true);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const chatDraftReady = useRef(false);
  const running = messages.find(
    (m) => m.role === "assistant" && m.state === "running",
  );
  const proposal = messages.findLast(
    (m) =>
      m.proposal &&
      m.state === "completed" &&
      !draft.adopted.includes(m.requestId),
  );
  useEffect(() => {
    storage
      .preference(`chat:${owner}:${initial.id}`)
      .then((value) => {
        if (typeof value === "string") setPrompt(value);
        chatDraftReady.current = true;
      })
      .catch(() => {
        chatDraftReady.current = true;
      });
  }, []);
  useEffect(() => {
    if (!chatDraftReady.current) return;
    const timer = setTimeout(() => {
      storage
        .preference(`chat:${owner}:${current.current.id}`, prompt)
        .catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [prompt]);
  useEffect(() => {
    setAdoptSummary(false);
    setSelectedActions([]);
  }, [proposal?.id]);
  function display(i: Idea) {
    current.current = i;
    setDraft(i);
  }
  function change(patch: Partial<Idea>) {
    const next = { ...current.current, ...patch };
    display(next);
    mutation.current = crypto.randomUUID();
    dirty.current = true;
    setCounter((c) => c + 1);
    setError("");
    setSaveStatus("等待保存");
  }
  async function persist() {
    if (!dirty.current) return;
    try {
      await storage.draft(owner, current.current.id, {
        idea: current.current,
        mutationId: mutation.current,
        dirty: true,
      });
      if (!saving.current) setSaveStatus("仅保存在此设备");
    } catch {
      setError("浏览器无法保存本地草稿，请下载备份，并保持页面打开");
    }
  }
  async function save(): Promise<boolean> {
    if (saving.current) {
      await saving.current;
      if (dirty.current && !conflictRef.current) return save();
      return !dirty.current;
    }
    if (!dirty.current) return true;
    await persist();
    if (!user || !onlineRef.current) {
      setSaveStatus("仅保存在此设备");
      return false;
    }
    if (!current.current.body.trim()) {
      setSaveStatus("等待输入正文");
      return false;
    }
    if (conflictRef.current) return false;
    const snapshot = current.current;
    const key = mutation.current;
    setSaveStatus("正在保存");
    const task = (async () => {
      try {
        const saved = await api<Idea>(
          snapshot.version ? `/ideas/${snapshot.id}` : "/ideas",
          { ...snapshot, mutationId: key },
          snapshot.version ? "PUT" : "POST",
        );
        if (mutation.current === key) {
          dirty.current = false;
          display(saved);
          await storage.removeDraft(owner, snapshot.id);
          setSaveStatus("已保存到服务端");
        } else {
          display({
            ...current.current,
            version: saved.version,
            summaryVersions: saved.summaryVersions,
            adopted: saved.adopted,
          });
          await storage.draft(owner, snapshot.id, {
            idea: current.current,
            mutationId: mutation.current,
            dirty: true,
          });
          setCounter((c) => c + 1);
        }
        await onSaved(saved);
        return !dirty.current;
      } catch (e) {
        if (
          e instanceof ApiError &&
          (e.code === "VERSION_CONFLICT" || e.code === "DELETED")
        ) {
          conflictRef.current = e.details;
          setConflict(e.details);
        }
        setError(errorText(e));
        setSaveStatus("保存失败 · 草稿已保留");
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = task;
    return task;
  }
  useEffect(() => {
    mounted.current = true;
    storage
      .draft(owner, initial.id)
      .then((local) => {
        if (local?.dirty) {
          display(local.idea);
          setTagsText(local.idea.tags.join("，"));
          mutation.current = local.mutationId;
          dirty.current = true;
          setSaveStatus("已恢复本地草稿");
        }
        loaded.current = true;
        setReady(true);
        if (dirty.current) setCounter((c) => c + 1);
      })
      .catch(() => {
        loaded.current = true;
        setReady(true);
      });
    return () => {
      mounted.current = false;
      if (dirty.current)
        void storage.draft(owner, current.current.id, {
          idea: current.current,
          mutationId: mutation.current,
          dirty: true,
        });
    };
  }, []);
  useEffect(() => {
    if (!loaded.current || !dirty.current) return;
    const local = setTimeout(() => void persist(), 800);
    const remote = setTimeout(() => void save(), 2000);
    return () => {
      clearTimeout(local);
      clearTimeout(remote);
    };
  }, [counter]);
  useEffect(() => {
    if (online && ready && dirty.current) void save();
  }, [online, ready]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        void persist();
        e.preventDefault();
      }
    };
    const hide = () => {
      if (document.visibilityState === "hidden") void persist();
    };
    window.addEventListener("beforeunload", before);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("beforeunload", before);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useImperativeHandle(ref, () => ({
    flush: async () => {
      await persist();
      if (user && online) await save();
      return !conflictRef.current;
    },
  }));
  async function loadMessages() {
    if (!user || !current.current.version || !online) return;
    try {
      const data = await api<Message[]>(
        `/ideas/${current.current.id}/messages`,
      );
      if (mounted.current) {
        setMessages(data);
        setChatError("");
        if (!data.some((m) => m.state === "running")) refreshQuota();
      }
    } catch (e) {
      if (mounted.current) setChatError(errorText(e));
    }
  }
  useEffect(() => {
    void loadMessages();
  }, [draft.id, !!draft.version, online]);
  useEffect(() => {
    if (!running || !online) return;
    const timer = setInterval(() => void loadMessages(), 550);
    return () => clearInterval(timer);
  }, [running?.requestId, online]);
  useEffect(() => {
    if (tab !== "chat") return;
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    else setHasNew(true);
  }, [messages, tab]);
  async function prepare(kind: "chat" | "summary" = "chat") {
    if (!user) {
      await persist();
      onLogin();
      return;
    }
    if (!online) {
      notify("离线时无法使用 AI，待发送内容会保留");
      return;
    }
    if (!consented) {
      setConsent(true);
      return;
    }
    const text =
      kind === "summary"
        ? "请整理当前想法与讨论，给出当前想法、已明确内容、待验证问题和候选行动。"
        : prompt.trim();
    if (!text) return;
    setBusy(true);
    setChatError("");
    try {
      if (!(await save()) || !current.current.version) {
        setChatError("请先成功保存原始记录，再与 AI 讨论");
        return;
      }
      const q = await api(`/ideas/${draft.id}/quote`, {
        prompt: text,
        mode: current.current.mode,
        kind,
        outputLimit,
      });
      setQuote({ ...q, prompt: text, kind, requestId: crypto.randomUUID() });
    } catch (e) {
      setChatError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!quote) return;
    setBusy(true);
    try {
      await api(`/ideas/${draft.id}/requests`, {
        id: quote.requestId,
        quoteId: quote.id,
      });
      if (quote.kind === "chat") {
        setPrompt("");
        await storage.preference(`chat:${owner}:${draft.id}`, "");
      }
      setQuote(null);
      setTab("chat");
      follow.current = true;
      await loadMessages();
      refreshQuota();
    } catch (e) {
      setChatError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function trash(restore = false) {
    if (!user) return;
    setBusy(true);
    try {
      if (!restore && !(await save())) return;
      const next = await api<Idea>(`/ideas/${draft.id}/trash`, {
        version: current.current.version,
        restore,
      });
      dirty.current = false;
      await storage.removeDraft(owner, draft.id);
      display(next);
      await onSaved(next);
      notify(restore ? "想法已恢复" : "想法已移入回收站");
      onBack();
    } catch (e) {
      notify(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function permanent() {
    if (!confirm("永久删除这条想法及其讨论、整理和行动？此操作无法撤销。"))
      return;
    try {
      await api(`/ideas/${draft.id}`, { confirm: true }, "DELETE");
      await storage.removeDraft(owner, draft.id);
      await storage.clearCache(owner);
      notify("已永久删除");
      onBack();
    } catch (e) {
      notify(errorText(e));
    }
  }
  async function adopt() {
    if (!proposal) return;
    setBusy(true);
    try {
      if (!(await save())) return;
      const next = await api<Idea>(`/ideas/${draft.id}/adopt`, {
        requestId: proposal.requestId,
        version: current.current.version,
        summary: adoptSummary,
        actions: selectedActions,
      });
      display(next);
      await onSaved(next);
      setTab("summary");
      notify("已采纳选择的内容，不会再次扣点");
    } catch (e) {
      notify(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function addAction() {
    if (!action.trim()) return;
    if ([...action.trim()].length > 200) {
      notify("行动最多 200 个字符");
      return;
    }
    if (draft.actions.filter((a) => !a.done).length >= 20) {
      notify("最多保留 20 个未完成行动");
      return;
    }
    change({
      actions: [
        ...draft.actions,
        { id: crypto.randomUUID(), text: action.trim(), done: false },
      ],
    });
    setAction("");
  }
  async function resolveConflict(mode: "cloud" | "merge" | "copy") {
    if (!conflict) return;
    const local = current.current;
    if (mode === "cloud") {
      dirty.current = false;
      display(conflict);
      setTagsText(conflict.tags.join("，"));
      await storage.removeDraft(owner, local.id);
      setSaveStatus("已使用服务端版本");
    } else if (mode === "copy") {
      const next = {
        ...blankIdea(),
        title: local.title + "（本地副本）",
        body: local.body,
        tags: local.tags,
        summary: local.summary,
        actions: local.actions,
      };
      await storage.removeDraft(owner, local.id);
      display(next);
      mutation.current = crypto.randomUUID();
      dirty.current = true;
      setCounter((c) => c + 1);
    } else {
      display({
        ...local,
        version: conflict.version,
        body: conflict.body + "\n\n—— 本地补充 ——\n" + local.body,
        summaryVersions: conflict.summaryVersions,
        adopted: conflict.adopted,
      });
      mutation.current = crypto.randomUUID();
      dirty.current = true;
      setCounter((c) => c + 1);
    }
    conflictRef.current = null;
    setConflict(null);
    setError("");
  }
  const isReadOnly = !!draft.deletedAt;
  return (
    <main className="editor-page">
      <div className="editor-toolbar">
        <button className="text-btn back-btn" onClick={onBack}>
          <ArrowLeft size={17} /> 返回想法
        </button>
        <div className="save-state" role="status">
          {saveStatus === "正在保存" ? (
            <Spinner />
          ) : saveStatus.includes("服务端") ? (
            <Cloud size={15} />
          ) : (
            <CloudOff size={15} />
          )}{" "}
          {saveStatus}
        </div>
        <div className="editor-actions">
          <button
            className={`icon-btn ${draft.favorite ? "starred" : ""}`}
            disabled={isReadOnly}
            aria-label="收藏当前想法"
            onClick={() => change({ favorite: !draft.favorite })}
          >
            <Star size={18} fill={draft.favorite ? "currentColor" : "none"} />
          </button>
          <button
            className="btn secondary compact"
            disabled={isReadOnly}
            onClick={async () => {
              if (user) {
                await save();
              } else {
                await persist();
                onLogin();
              }
            }}
          >
            <Save size={15} />
            <span>{user ? "保存" : "登录保存"}</span>
          </button>
          <div className="dropdown-wrap">
            <button
              className="icon-btn"
              aria-label="更多操作"
              onClick={() => setMore(!more)}
            >
              <MoreHorizontal size={20} />
            </button>
            {more && (
              <div className="dropdown">
                {user && draft.version > 0 && (
                  <>
                    <button
                      onClick={() => {
                        setExportOpen(true);
                        setMore(false);
                      }}
                    >
                      <ArrowDownToLine size={16} />
                      导出 Markdown
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          setHistory(await api(`/ideas/${draft.id}/revisions`));
                          setMore(false);
                        } catch (e) {
                          notify(errorText(e));
                        }
                      }}
                    >
                      <History size={16} />
                      记录版本
                    </button>
                    {!isReadOnly && (
                      <>
                        <button
                          onClick={() => {
                            change({ archived: !draft.archived });
                            setMore(false);
                          }}
                        >
                          <Archive size={16} />
                          {draft.archived ? "取消归档" : "归档想法"}
                        </button>
                        <button
                          className="danger-text"
                          disabled={!!running || busy}
                          onClick={() => {
                            setMore(false);
                            void trash();
                          }}
                        >
                          <Trash2 size={16} />
                          移入回收站
                        </button>
                      </>
                    )}
                  </>
                )}
                <button
                  onClick={() => {
                    download(
                      "本地想法备份.json",
                      JSON.stringify(current.current, null, 2),
                      "application/json",
                    );
                    setMore(false);
                  }}
                >
                  <ArrowDownToLine size={16} />
                  下载本地备份
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {error && (
        <div className="banner error-banner" role="alert">
          {error}
          <button className="text-btn" onClick={() => void save()}>
            重试保存
          </button>
        </div>
      )}
      {isReadOnly && (
        <div className="banner">
          这条想法在回收站中，无法编辑或调用 AI。
          <button
            className="text-btn"
            disabled={!online || busy}
            onClick={() => trash(true)}
          >
            恢复想法
          </button>
          <button
            className="text-btn danger-text"
            disabled={!online}
            onClick={permanent}
          >
            永久删除
          </button>
        </div>
      )}
      <div className="editor-heading">
        <div className="editor-label">
          <span className="idea-symbol sage">
            <Leaf size={22} />
          </span>
          <span>留住灵感 · 慢慢想清楚</span>
        </div>
        <input
          className="title-input"
          aria-label="想法标题"
          placeholder="给这个想法起个名字…"
          value={draft.title}
          onChange={(e) => change({ title: e.target.value })}
          disabled={isReadOnly}
        />
        <div className="editor-meta">
          <select
            aria-label="想法进展状态"
            disabled={isReadOnly}
            value={draft.status}
            onChange={(e) =>
              change({ status: e.target.value as Idea["status"] })
            }
          >
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <span className="meta-divider" />
          <input
            className="tags-input"
            aria-label="标签，以逗号分隔"
            placeholder="＋ 添加标签（逗号分隔）"
            disabled={isReadOnly}
            value={tagsText}
            onChange={(e) => {
              setTagsText(e.target.value);
              change({
                tags: e.target.value
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              });
            }}
          />
          <span className="created-date">{fullDate(draft.createdAt)}</span>
        </div>
      </div>
      <div className="editor-tabs" role="tablist" aria-label="想法内容">
        <button
          role="tab"
          aria-selected={tab === "record"}
          className={tab === "record" ? "active" : ""}
          onClick={() => setTab("record")}
        >
          <FileText size={17} />
          原始记录
        </button>
        <button
          role="tab"
          aria-selected={tab === "chat"}
          className={tab === "chat" ? "active" : ""}
          onClick={() => setTab("chat")}
        >
          <MessageCircle size={17} />
          AI 讨论
          {messages.length > 0 && (
            <span>{Math.floor(messages.length / 2)}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "summary"}
          className={tab === "summary" ? "active" : ""}
          onClick={() => setTab("summary")}
        >
          <CheckCheck size={17} />
          整理与行动{proposal && <i className="mini-dot" />}
        </button>
      </div>
      {tab === "record" && (
        <div className="record-layout">
          <section className="record-paper">
            <div className="section-caption">
              <span>原始记录</span>
              <span>你的声音，原样保留</span>
            </div>
            <textarea
              aria-label="原始记录"
              placeholder={
                "不用组织好语言。\n\n先写下你脑海里的那个念头，哪怕它还不够清楚。"
              }
              value={draft.body}
              disabled={isReadOnly}
              onChange={(e) => change({ body: e.target.value })}
            />
            <footer>
              <span>{[...draft.body].length.toLocaleString()} / 20,000 字</span>
              <span>
                <ShieldCheck size={13} /> AI 不会改写你的原始记录
              </span>
            </footer>
          </section>
          <aside className="thinking-panel">
            <span className="thinking-icon">
              <Sparkles size={24} />
            </span>
            <h3>一个想法，可以有更多可能</h3>
            <p>
              不急着得到答案。让 AI 陪你提问、推敲，把模糊的地方一点点想清楚。
            </p>
            {[
              ["帮我理清", "帮我理清这个想法，先提出最值得思考的问题。"],
              ["找出问题", "请找出这个想法中最关键的假设和可能的问题。"],
              ["给我下一步", "请建议我现在可以迈出的最小一步。"],
            ].map(([label, text]) => (
              <button
                className="thought-prompt"
                key={label}
                disabled={isReadOnly}
                onClick={() => {
                  setPrompt(text);
                  setTab("chat");
                }}
              >
                <span>{label}</span>
                <ArrowUpRightIcon />
              </button>
            ))}
            <small>先查看并编辑问题，再确认发送。</small>
            <div className="gentle-note">
              <span>✦</span>
              <p>
                “想法的价值，始于你愿意
                <br />
                多想一步的那个瞬间。”
              </p>
            </div>
          </aside>
        </div>
      )}
      {tab === "chat" && (
        <div className="chat-layout">
          <section className="chat-panel">
            <div className="chat-top">
              <div>
                <span className="ai-avatar">
                  <Sparkles size={17} />
                </span>
                <strong>一起想一想</strong>
                <span className="muted">
                  {config.aiDemo ? "本地演示" : "AI 讨论"}
                </span>
              </div>
              <button className="text-btn" onClick={() => setModelInfo(true)}>
                模型与数据说明
              </button>
            </div>
            {!online && (
              <p className="notice">
                离线时不缓存或加载完整对话，联网后可继续讨论。
              </p>
            )}
            <div
              className="messages"
              ref={scroll}
              onScroll={() => {
                const el = scroll.current;
                if (el)
                  follow.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 90;
              }}
            >
              {messages.length === 0 ? (
                <div className="chat-empty">
                  <div className="ai-orb">
                    <Sparkles size={30} />
                  </div>
                  <h2>想法不用一个人想</h2>
                  <p>
                    我会结合你的原始记录与这条想法的讨论，
                    <br />
                    陪你找到更清楚的方向。
                  </p>
                  <div className="prompt-chips">
                    {[
                      "帮我理清这个想法",
                      "这个想法有哪些风险？",
                      "我可以先做什么？",
                    ].map((t) => (
                      <button key={t} onClick={() => setPrompt(t)}>
                        {t}
                        <ArrowRight size={13} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`message ${m.role}`}>
                    <span className="message-avatar">
                      {m.role === "user" ? "我" : <Sparkles size={16} />}
                    </span>
                    <div className="message-body">
                      <div className="message-name">
                        {m.role === "user"
                          ? "你"
                          : config.aiDemo
                            ? "一念 · 演示助手"
                            : "一念 · AI 助手"}
                        <time>
                          {new Date(m.createdAt).toLocaleTimeString("zh-CN", {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      <div className="message-content">
                        {m.kind === "summary" && m.role === "assistant" ? (
                          m.state === "running" ? (
                            <span className="typing">
                              <Spinner /> 正在整理思路…
                            </span>
                          ) : m.proposal ? (
                            <div className="proposal-ready">
                              <CheckCheck size={22} />
                              <strong>整理提议已准备好</strong>
                              <p>不会自动改写你的记录，请查看后选择采纳。</p>
                              <button
                                className="btn secondary"
                                onClick={() => setTab("summary")}
                              >
                                查看整理提议 <ArrowRight size={15} />
                              </button>
                            </div>
                          ) : (
                            m.content || "未能生成有效整理"
                          )
                        ) : (
                          m.content ||
                          (m.state === "running" ? (
                            <span className="typing">
                              <Spinner /> 正在思考…
                            </span>
                          ) : (
                            "暂无有效回复"
                          ))
                        )}
                      </div>
                      {m.role === "assistant" && m.state !== "running" && (
                        <div className="message-foot">
                          <span>
                            {m.state === "failed"
                              ? "生成失败 · 预占已释放"
                              : m.state === "stopped"
                                ? "已停止生成"
                                : m.limited
                                  ? "已达到本次长度上限"
                                  : "已完成"}{" "}
                            · {m.charged || 0} 点
                          </span>
                          {m.error && <p className="error">{m.error}</p>}
                          {m.note && <p>{m.note}</p>}
                          {["failed", "stopped"].includes(m.state) && (
                            <button
                              className="text-btn"
                              onClick={() => {
                                const source = messages.find(
                                  (x) =>
                                    x.requestId === m.requestId &&
                                    x.role === "user",
                                );
                                setPrompt(source?.content || "");
                                notify(
                                  "已填入原问题。重新发送是新的请求，可能消耗额度。",
                                );
                              }}
                            >
                              重新编辑并发送
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            {hasNew && (
              <button
                className="new-replies"
                onClick={() => {
                  follow.current = true;
                  if (scroll.current)
                    scroll.current.scrollTop = scroll.current.scrollHeight;
                  setHasNew(false);
                }}
              >
                有新回复 ↓
              </button>
            )}
            {chatError && (
              <p className="error chat-error" role="alert">
                {chatError}
              </p>
            )}
            <div className="composer">
              <textarea
                aria-label="发送给 AI 的消息"
                placeholder="接着说说你的想法…"
                value={prompt}
                disabled={isReadOnly}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    (e.ctrlKey || e.metaKey) &&
                    !(e.nativeEvent as any).isComposing
                  ) {
                    e.preventDefault();
                    void prepare();
                  }
                }}
              />
              <div className="composer-tools">
                <div className="mode-controls">
                  <select
                    aria-label="AI 模式"
                    value={draft.mode}
                    disabled={!!running || isReadOnly}
                    onChange={(e) =>
                      change({ mode: e.target.value as Idea["mode"] })
                    }
                  >
                    <option value="quick">✧ 快速讨论</option>
                    <option value="deep">✦ 深度分析</option>
                  </select>
                  <select
                    aria-label="回复长度上限"
                    value={outputLimit}
                    onChange={(e) => setOutputLimit(Number(e.target.value))}
                  >
                    {[
                      256,
                      512,
                      1024,
                      2048,
                      ...(draft.mode === "deep" ? [4096] : []),
                    ].map((n) => (
                      <option value={n} key={n}>
                        {n} tokens
                      </option>
                    ))}
                  </select>
                </div>
                {running ? (
                  <button
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        await api(`/requests/${running.requestId}/stop`, {});
                        await loadMessages();
                      } catch (e) {
                        notify(errorText(e));
                      }
                    }}
                  >
                    <Square size={14} />
                    停止
                  </button>
                ) : (
                  <button
                    className="btn primary"
                    disabled={busy || isReadOnly || !prompt.trim()}
                    onClick={() => prepare()}
                  >
                    {busy ? <Spinner /> : <Send size={16} />}
                    <span>发送</span>
                  </button>
                )}
              </div>
            </div>
            <div className="composer-foot">
              {config.aiDemo
                ? "演示回复不调用真实模型，使用演示额度。"
                : "AI 可能出错，重要信息请自行核实。"}{" "}
              · Ctrl / ⌘ + Enter 发送
            </div>
          </section>
          <aside className="context-panel">
            <div className="section-caption">
              <span>
                <FileText size={15} /> 本次讨论的背景
              </span>
            </div>
            <h3>{draft.title || "未命名想法"}</h3>
            <p>{draft.body}</p>
            <div className="context-note">
              <ShieldCheck size={15} /> 只结合当前想法，不读取其他记录
            </div>
            <button
              className="btn secondary full"
              disabled={busy || !!running || isReadOnly}
              onClick={() => prepare("summary")}
            >
              <CheckCheck size={16} /> 整理当前想法
            </button>
            <small>生成会消耗额度，采纳不会再次扣费。</small>
          </aside>
        </div>
      )}
      {tab === "summary" && (
        <div className="summary-layout">
          <section className="summary-main">
            {proposal && (
              <section className="proposal-card">
                <div className="proposal-header">
                  <span>
                    <Sparkles size={18} /> 有一份新的整理提议
                  </span>
                  <span className="pill">等待你确认</span>
                </div>
                <p>勾选想保留的内容。采纳前，你的正式整理不会改变。</p>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={adoptSummary}
                    onChange={(e) => setAdoptSummary(e.target.checked)}
                  />
                  <strong>用以下提议替换正式整理</strong>
                </label>
                <div className="compare-columns">
                  <div>
                    <span className="compare-label">当前正式整理</span>
                    {Object.entries(draft.summary).map(([k, v]) => (
                      <p key={k}>{v || "尚未填写"}</p>
                    ))}
                  </div>
                  <div>
                    <span className="compare-label">AI 提议</span>
                    {Object.entries(proposal.proposal!.summary).map(
                      ([k, v]) => (
                        <p key={k}>{v}</p>
                      ),
                    )}
                  </div>
                </div>
                <strong className="candidate-label">
                  候选行动 · 选择后才加入清单
                </strong>
                {proposal.proposal!.actions.map((a, index) => (
                  <label className="check-line" key={index}>
                    <input
                      type="checkbox"
                      checked={selectedActions.includes(index)}
                      onChange={(e) =>
                        setSelectedActions(
                          e.target.checked
                            ? [...selectedActions, index]
                            : selectedActions.filter((n) => n !== index),
                        )
                      }
                    />
                    <span>{a}</span>
                  </label>
                ))}
                <div className="proposal-actions">
                  <button
                    className="btn secondary"
                    onClick={async () => {
                      try {
                        await api(
                          "/requests/" + proposal.requestId + "/dismiss",
                          {},
                        );
                        await loadMessages();
                        notify("已放弃提议，生成费用不会退回");
                      } catch (e) {
                        notify(errorText(e));
                      }
                    }}
                  >
                    暂不采纳
                  </button>
                  <button
                    className="btn primary"
                    disabled={
                      busy ||
                      (!adoptSummary && !selectedActions.length) ||
                      isReadOnly
                    }
                    onClick={adopt}
                  >
                    {busy ? <Spinner /> : <Check size={16} />}采纳所选内容
                  </button>
                </div>
                {proposal.baseVersion !== draft.version && (
                  <p className="error">
                    记录已在生成后变化。请对照提议手动编辑整理，或重新生成。
                  </p>
                )}
              </section>
            )}
            <div className="summary-title">
              <h2>想清楚的部分，留在这里</h2>
              <button
                className="text-btn"
                onClick={() => setSummaryHistory(true)}
              >
                <History size={15} /> 版本记录
              </button>
            </div>
            <p className="muted">这是你确认过的内容，也可以随时亲手修改。</p>
            {(
              [
                ["current", "当前想法", "用一句话说清楚，你想做什么。"],
                ["known", "已经明确的内容", "记录已经确认的事实、目标与约束。"],
                ["questions", "待验证的问题", "哪些问题，还需要继续探索？"],
              ] as const
            ).map(([key, label, placeholder], index) => (
              <section className="summary-block" key={key}>
                <h3>
                  <span>0{index + 1}</span>
                  {label}
                </h3>
                <textarea
                  aria-label={label}
                  placeholder={placeholder}
                  value={draft.summary[key]}
                  disabled={isReadOnly}
                  onChange={(e) =>
                    change({
                      summary: { ...draft.summary, [key]: e.target.value },
                    })
                  }
                />
              </section>
            ))}
            <button
              className="btn secondary"
              disabled={busy || !!running || isReadOnly}
              onClick={() => prepare("summary")}
            >
              <Sparkles size={16} /> 让 AI 提议一版整理
            </button>
            {chatError && <p className="error">{chatError}</p>}
          </section>
          <aside className="action-panel">
            <div className="action-heading">
              <h3>
                <CheckCheck size={18} /> 下一步行动
              </h3>
              <span>
                {draft.actions.filter((a) => a.done).length}/
                {draft.actions.length}
              </span>
            </div>
            <p>不用一次做完，先迈出小小的一步。</p>
            <div className="action-progress">
              <span
                style={{
                  width: `${draft.actions.length ? (draft.actions.filter((a) => a.done).length / draft.actions.length) * 100 : 0}%`,
                }}
              />
            </div>
            {draft.actions.length === 0 && (
              <div className="actions-empty">
                <span>↗</span>
                <p>
                  把想法变成一个
                  <br />
                  可以开始的小行动
                </p>
              </div>
            )}
            {draft.actions.map((a) => (
              <div className={`action-item ${a.done ? "done" : ""}`} key={a.id}>
                <input
                  type="checkbox"
                  aria-label={`完成行动：${a.text}`}
                  disabled={isReadOnly}
                  checked={a.done}
                  onChange={(e) =>
                    change({
                      actions: draft.actions.map((x) =>
                        x.id === a.id ? { ...x, done: e.target.checked } : x,
                      ),
                    })
                  }
                />
                <input
                  aria-label="行动内容"
                  value={a.text}
                  disabled={isReadOnly}
                  onChange={(e) =>
                    change({
                      actions: draft.actions.map((x) =>
                        x.id === a.id ? { ...x, text: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  className="icon-btn"
                  aria-label="删除行动"
                  disabled={isReadOnly}
                  onClick={() =>
                    change({
                      actions: draft.actions.filter((x) => x.id !== a.id),
                    })
                  }
                >
                  <X size={14} />
                </button>
              </div>
            ))}
            <form
              className="action-add"
              onSubmit={(e) => {
                e.preventDefault();
                addAction();
              }}
            >
              <input
                aria-label="添加行动"
                placeholder="写下一个小行动…"
                disabled={isReadOnly}
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
              <button
                className="icon-btn"
                aria-label="确认添加行动"
                disabled={!action.trim() || isReadOnly}
              >
                <Plus size={18} />
              </button>
            </form>
            <small>最多 20 个未完成行动 · 完成情况由你决定</small>
          </aside>
        </div>
      )}
      {consent && (
        <Modal
          title="开始之前，了解数据如何使用"
          onClose={() => setConsent(false)}
        >
          <p>
            讨论会发送当前想法正文、已确认整理、当前问题及本想法的相关对话。
          </p>
          <div className="notice">
            <strong>服务商：{config.provider}</strong>
            <p>
              {config.aiDemo
                ? "当前为本地演示，内容不会发送到第三方。配置真实模型后会发送至对应服务商。"
                : "请求通过服务端发送至所配置的模型服务商；数据保留与使用遵循该服务商条款。"}
            </p>
            {config.policyURL && (
              <a href={config.policyURL} target="_blank" rel="noreferrer">
                查看 AI 数据使用说明 ↗
              </a>
            )}
          </div>
          <p className="muted">
            不会读取其他想法，不会自动执行行动。AI 没有联网检索能力。
          </p>
          <button
            className="btn primary full"
            onClick={async () => {
              try {
                await api("/auth/ai-consent", {});
                setConsented(true);
                onConsent();
                setConsent(false);
                notify("已确认，请再次发送问题");
              } catch (e) {
                notify(errorText(e));
              }
            }}
          >
            了解并同意
          </button>
        </Modal>
      )}
      {modelInfo && (
        <Modal title="模型与数据说明" onClose={() => setModelInfo(false)}>
          <dl className="detail-list">
            <dt>服务商</dt>
            <dd>{config.provider}</dd>
            <dt>快速模型</dt>
            <dd>{config.quickModel}</dd>
            <dt>深度模型</dt>
            <dd>{config.deepModel}</dd>
            <dt>计量规则</dt>
            <dd>
              快速：每千输入 1 点、每千输出 4 点；深度：4 点 / 16
              点。向上取整，成功最低 1 点。特殊推理成本由平台承担。
            </dd>
          </dl>
          <p className="muted">
            费率为联调示例。每次发送前展示预占上限；失败释放全部预占。模型回复以纯文本安全显示，不加载外部图片。
          </p>
        </Modal>
      )}
      {quote && (
        <Modal
          title={draft.mode === "deep" ? "确认深度分析" : "确认这次讨论"}
          onClose={() => {
            if (!busy) setQuote(null);
          }}
        >
          <div className="quote-amount">
            <Sparkles size={25} />
            <span>本次最多消耗</span>
            <strong>
              {quote.maximum}
              <small> 点</small>
            </strong>
            <p>当前可用 {quote.available} 点</p>
          </div>
          <p className="muted">
            先预占上限，结束后按实际用量结算并释放剩余额度。
            {config.aiDemo ? "当前消耗的是本地演示额度。" : ""}
          </p>
          {quote.truncated && (
            <p className="notice">
              上下文较长，本次仅发送最近可容纳的对话，完整历史仍保留。当前问题与原始记录未截断。
            </p>
          )}
          <div className="quote-prompt">{quote.prompt}</div>
          {chatError && (
            <p className="error" role="alert">
              {chatError}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => setQuote(null)}
            >
              返回修改
            </button>
            <button
              className="btn primary"
              disabled={busy || quote.maximum > quote.available}
              onClick={send}
            >
              {busy ? <Spinner /> : <Send size={16} />}确认发送
            </button>
          </div>
          {quote.maximum > quote.available && (
            <p className="error">
              额度不足，请返回降低回复长度上限后重新估算。
            </p>
          )}
        </Modal>
      )}
      {conflict && (
        <Modal
          wide
          title={
            conflict.deletedAt ? "服务端想法已删除" : "发现另一份更新的内容"
          }
          onClose={() => {}}
        >
          <p>本地草稿与服务端内容均已保留，请比较后选择。</p>
          <div className="compare-columns">
            <div>
              <strong>本地草稿</strong>
              <pre>{draft.body}</pre>
              <pre>{JSON.stringify(draft.summary, null, 2)}</pre>
            </div>
            <div>
              <strong>服务端 · 版本 {conflict.version}</strong>
              <pre>{conflict.body}</pre>
              <pre>{JSON.stringify(conflict.summary, null, 2)}</pre>
            </div>
          </div>
          <div className="modal-actions wrap">
            <button
              className="btn secondary"
              onClick={() => resolveConflict("cloud")}
            >
              {conflict.deletedAt ? "丢弃本地修改" : "使用服务端内容"}
            </button>
            <button
              className="btn secondary"
              onClick={() => resolveConflict("copy")}
            >
              本地另存为新想法
            </button>
            {!conflict.deletedAt && (
              <button
                className="btn primary"
                onClick={() => resolveConflict("merge")}
              >
                合并正文，其余使用本地版本
              </button>
            )}
          </div>
        </Modal>
      )}
      {history && (
        <Modal wide title="原始记录版本" onClose={() => setHistory(null)}>
          <p className="muted">
            保留最近 20 个保存版本。恢复只影响标题与正文。
          </p>
          <div className="version-list">
            {history.map((r) => (
              <article key={r.version}>
                <strong>
                  版本 {r.version} · {fullDate(r.created_at)}
                </strong>
                <pre>{r.data.body}</pre>
                <button
                  className="btn secondary"
                  disabled={isReadOnly}
                  onClick={() => {
                    change({ title: r.data.title, body: r.data.body });
                    setHistory(null);
                  }}
                >
                  恢复此版记录
                </button>
              </article>
            ))}
          </div>
        </Modal>
      )}
      {summaryHistory && (
        <Modal title="整理版本记录" onClose={() => setSummaryHistory(false)}>
          {draft.summaryVersions.length ? (
            draft.summaryVersions
              .slice()
              .reverse()
              .map((r, index) => (
                <article className="version-entry" key={index}>
                  <strong>{fullDate(r.at)}</strong>
                  <pre>
                    {Object.values(r.summary).join("\n\n") || "空白整理"}
                  </pre>
                  <button
                    className="btn secondary"
                    disabled={isReadOnly}
                    onClick={() => {
                      change({ summary: r.summary });
                      setSummaryHistory(false);
                      notify("已恢复整理版本，不扣点");
                    }}
                  >
                    恢复此版本
                  </button>
                </article>
              ))
          ) : (
            <p className="muted">编辑或采纳整理后，旧版本会出现在这里。</p>
          )}
        </Modal>
      )}
      {exportOpen && (
        <Modal title="导出这条想法" onClose={() => setExportOpen(false)}>
          <p>包含原始记录、已确认整理、行动项、标签、状态与时间。</p>
          <label className="check-line">
            <input
              type="checkbox"
              checked={includeChat}
              onChange={(e) => setIncludeChat(e.target.checked)}
            />
            同时包含对话记录
          </label>
          <button
            className="btn primary full"
            disabled={!online}
            onClick={async () => {
              if (!(await save())) return;
              location.href = `/api/ideas/${draft.id}/export?chat=${includeChat}`;
              setExportOpen(false);
            }}
          >
            <ArrowDownToLine size={17} />
            下载 Markdown
          </button>
        </Modal>
      )}
    </main>
  );
});
function ArrowUpRightIcon() {
  return <ArrowRight size={15} style={{ transform: "rotate(-40deg)" }} />;
}
