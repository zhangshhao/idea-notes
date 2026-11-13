import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  Cloud,
  CloudOff,
  CreditCard,
  Grid2X2,
  Leaf,
  List,
  LogIn,
  Menu,
  Plus,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { Auth } from "./Auth";
import { Editor, type EditorHandle } from "./Editor";
import { Subscription, SettingsPage, AdminPage } from "./Pages";
import { planName } from "./Billing";
import { Brand, Empty, Modal, Spinner } from "./ui";
import { api, displayDate, errorText, storage, download } from "./lib";
import {
  blankIdea,
  statuses,
  type Config,
  type Idea,
  type Quota,
  type Section,
  type User,
} from "./types";

const sectionTitles: Record<Section, string> = {
  all: "我的想法",
  favorites: "我的收藏",
  archive: "已归档",
  trash: "回收站",
  subscription: "订阅与额度",
  settings: "个人设置",
  admin: "管理后台",
};
const examples = [
  {
    title: "把零散的灵感，变成一份周刊",
    body: "我想做一份面向普通人的设计观察周刊。每周记录三个生活中让人觉得贴心的小设计，解释它们为什么好用。\n\n希望读者在十分钟内读完，也能开始留意身边的设计。",
    tag: "内容创作",
    color: "sage",
    icon: "✳",
  },
  {
    title: "一间只在周末营业的咖啡馆",
    body: "如果在社区里开一家周末咖啡馆，让附近的人可以带着自己的书交换、聊天，会不会有人喜欢？\n\n先不租店铺，或许可以和现有空间合作，尝试一次小活动。",
    tag: "生活灵感",
    color: "peach",
    icon: "☕",
  },
  {
    title: "给自己留一个不看手机的小时",
    body: "我发现每天都在接收信息，却很少有时间真正思考。想尝试每天晚饭后一小时不看手机，用纸笔记录当天最值得记住的事情。",
    tag: "个人成长",
    color: "lavender",
    icon: "↗",
  },
];
export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<Config>({
    development: true,
    aiDemo: true,
    provider: "本地演示",
    quickModel: "demo",
    deepModel: "demo",
    policyURL: "",
    paymentEnabled: false,
  });
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [section, setSection] = useState<Section>(
    new URLSearchParams(location.search).has("payment_order")
      ? "subscription"
      : "all",
  );
  const [selected, setSelected] = useState<Idea | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [items, setItems] = useState<Idea[]>([]);
  const [counts, setCounts] = useState<any>({
    all: 0,
    favorites: 0,
    archive: 0,
    trash: 0,
  });
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [filterOpen, setFilterOpen] = useState(false);
  const [quick, setQuick] = useState("");
  const [install, setInstall] = useState<any>(null);
  const [installHelp, setInstallHelp] = useState(false);
  const [sw, setSw] = useState<ServiceWorker | null>(null);
  const [guestDraft, setGuestDraft] = useState<Idea | null>(null);
  const [transfer, setTransfer] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const listScroll = useRef(0);
  const generation = useRef(0);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key.toLowerCase() !== "n" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target.closest("input,textarea,select,[contenteditable],dialog")
      )
        return;
      event.preventDefault();
      void create();
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const notify = (message: string) => setToast(message);
  async function refreshSession() {
    const result = await api("/me");
    if (result.user) setSelected(null);
    setUser(result.user);
    setConfig(result);
    await storage.preference("lastUser", result.user);
    if (result.user) {
      const drafts = await storage.drafts("guest");
      if (drafts.some((d) => d.idea.body.trim())) {
        setGuestDraft(drafts[0].idea);
        setTransfer(true);
      } else setSelected(null);
    }
    return result.user as User | null;
  }
  useEffect(() => {
    refreshSession()
      .catch(async () => {
        const cached = await storage.preference("lastUser");
        if (cached) {
          setUser(cached);
          setOnline(false);
        } else setError("无法连接服务，请检查网络后刷新。");
      })
      .finally(() => setReady(true));
    const network = () => setOnline(navigator.onLine);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    const installer = (e: Event) => {
      e.preventDefault();
      setInstall(e);
    };
    window.addEventListener("beforeinstallprompt", installer);
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          if (reg.waiting) setSw(reg.waiting);
          reg.addEventListener("updatefound", () => {
            const worker = reg.installing;
            worker?.addEventListener("statechange", () => {
              if (
                worker.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setSw(worker);
            });
          });
        })
        .catch(() => {});
    }
    return () => {
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      window.removeEventListener("beforeinstallprompt", installer);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function load() {
    const seq = ++generation.current;
    if (!user) {
      setItems([]);
      return;
    }
    if (!["all", "favorites", "archive", "trash"].includes(section)) return;
    setLoading(true);
    setError("");
    try {
      if (!online) {
        const cached = await storage.cached(user.id);
        const drafts = await storage.drafts(user.id);
        const map = new Map(cached.map((i) => [i.id, i]));
        drafts.forEach((d) => map.set(d.idea.id, d.idea));
        const list = [...map.values()].filter(
          (i) =>
            (section === "trash"
              ? !!i.deletedAt
              : !i.deletedAt &&
                (section === "archive" ? i.archived : !i.archived)) &&
            (section !== "favorites" || i.favorite) &&
            (!status || i.status === status) &&
            (!tag || i.tags.includes(tag)) &&
            `${i.title} ${i.body} ${Object.values(i.summary).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
        if (seq === generation.current) {
          setItems(list);
          setTotal(list.length);
        }
        return;
      }
      const data = await api(
        `/ideas?${new URLSearchParams({ view: section, q: query, status, tag, page: String(page) })}`,
      );
      if (seq !== generation.current) return;
      setItems(data.items);
      setTotal(data.total);
      setCounts(data.counts);
      setTags(data.tags);
    } catch (e) {
      if (seq === generation.current) setError(errorText(e));
    } finally {
      if (seq === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    const t = setTimeout(() => void load(), 180);
    return () => clearTimeout(t);
  }, [user, online, section, query, status, tag, page]);
  const refreshQuota = () => {
    if (user && online)
      api<Quota>("/quota")
        .then(setQuota)
        .catch(() => {});
  };
  useEffect(refreshQuota, [user, online]);
  useEffect(() => {
    if (!ready || !user || !online) return;
    const id = location.hash.slice(1);
    if (id && /^[a-f0-9-]{36}$/.test(id)) {
      api<Idea>(`/ideas/${id}`)
        .then(open)
        .catch(() => {
          location.hash = "";
        });
    }
  }, [ready, user?.id]);
  async function open(i: Idea) {
    if (editor.current && !(await editor.current.flush())) return;
    if (!selected) listScroll.current = window.scrollY;
    setSelected(i);
    location.hash = i.id;
    setSidebar(false);
    if (user) storage.cache(user.id, i).catch(() => {});
  }
  async function navigate(s: Section) {
    if (editor.current && !(await editor.current.flush())) return;
    setSelected(null);
    setSection(s);
    setSidebar(false);
    setPage(0);
    location.hash = "";
    requestAnimationFrame(() =>
      window.scrollTo(0, s === section ? listScroll.current : 0),
    );
  }
  async function create(body = "") {
    if (!user) {
      const drafts = await storage.drafts("guest");
      if (drafts.length && drafts[0].idea.body.trim()) {
        setSelected(drafts[0].idea);
        setSidebar(false);
        return;
      }
    }
    const i = blankIdea();
    i.body = body;
    await open(i);
    setQuick("");
  }
  async function onSaved(i: Idea) {
    setSelected(i);
    history.replaceState(null, "", `#${i.id}`);
    if (user) await storage.cache(user.id, i);
    void load();
  }
  async function toggleStar(e: React.MouseEvent, i: Idea) {
    e.stopPropagation();
    try {
      const saved = await api<Idea>(
        `/ideas/${i.id}`,
        { ...i, favorite: !i.favorite, mutationId: crypto.randomUUID() },
        "PUT",
      );
      setItems(items.map((x) => (x.id === i.id ? saved : x)));
      void load();
    } catch (e) {
      notify(errorText(e));
    }
  }
  async function syncAll() {
    if (!user || !online) return;
    let synced = 0;
    try {
      for (const d of await storage.drafts(user.id)) {
        if (!d.dirty || !d.idea.body.trim() || d.idea.id === selected?.id)
          continue;
        try {
          const saved = await api<Idea>(
            d.idea.version ? `/ideas/${d.idea.id}` : "/ideas",
            { ...d.idea, mutationId: d.mutationId },
            d.idea.version ? "PUT" : "POST",
          );
          await storage.removeDraft(user.id, d.idea.id);
          await storage.cache(user.id, saved);
          synced++;
        } catch (e) {
          if (
            (e as any).code === "VERSION_CONFLICT" ||
            (e as any).code === "DELETED"
          ) {
            notify("有离线草稿需要比较，请打开后处理");
            await open(d.idea);
            return;
          }
          throw e;
        }
      }
      if (editor.current) await editor.current.flush();
      if (synced) notify(`已同步 ${synced} 条离线草稿`);
      void load();
    } catch (e) {
      notify(errorText(e));
    }
  }
  useEffect(() => {
    if (user && online) void syncAll();
  }, [online, user?.id]);
  async function logout() {
    if (!user) return;
    if (editor.current && !(await editor.current.flush())) return;
    const drafts = await storage.drafts(user.id);
    if (drafts.some((d) => d.dirty)) {
      if (
        !confirm(
          "还有未同步草稿。确定导出草稿并退出吗？当前账号的本地缓存将清除。",
        )
      )
        return;
      download(
        "未同步想法.json",
        JSON.stringify(drafts, null, 2),
        "application/json",
      );
    }
    try {
      await api("/auth/logout", {});
      await storage.clear(user.id);
      await storage.preference("lastUser", null);
      setSelected(null);
      setUser(null);
      setQuota(null);
      setSection("all");
      location.hash = "";
      notify("已退出，当前账号的本地缓存已清除");
    } catch (e) {
      notify(errorText(e));
    }
  }
  async function importGuest() {
    if (!user || !guestDraft) return;
    try {
      const imported = await api<Idea>(
        "/ideas",
        { ...guestDraft, version: 0 },
        "POST",
      );
      await storage.clear("guest");
      setTransfer(false);
      setGuestDraft(null);
      await open(imported);
      notify("草稿已保存到服务端");
    } catch (e) {
      notify(errorText(e));
    }
  }
  const navItems: [Section, typeof Leaf][] = [
    ["all", BookOpen],
    ["favorites", Star],
    ["archive", Archive],
    ["trash", Trash2],
  ];
  return (
    <div className="app-shell">
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className={`sidebar ${sidebar ? "visible" : ""}`}>
        <Brand />
        <button className="btn primary new-idea" onClick={() => create()}>
          <Plus size={19} /> 记下新想法 <span>N</span>
        </button>
        <div className="nav-label">我的空间</div>
        <nav>
          {navItems.map(([key, Icon]) => (
            <button
              className={`nav-item ${section === key && !selected ? "active" : ""}`}
              key={key}
              onClick={() => navigate(key)}
            >
              <Icon size={19} />
              <span>{sectionTitles[key]}</span>
              {counts[key] > 0 && <small>{counts[key]}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="grow-card">
            <div className="tiny-spark">
              <Sparkles size={18} />
            </div>
            <strong>让每个想法，多走一步</strong>
            <p>
              和 AI 聊一聊，让模糊的灵感
              <br />
              慢慢变得清晰。
            </p>
            <button
              className="text-btn"
              onClick={() => navigate("subscription")}
            >
              了解 AI 额度 <ArrowUpRight size={14} />
            </button>
          </div>
          <nav>
            <button
              className={`nav-item ${section === "subscription" ? "active" : ""}`}
              onClick={() => navigate("subscription")}
            >
              <CreditCard size={19} />
              <span>订阅与额度</span>
              <small className="free-tag">
                {quota?.plan === "standard"
                  ? "PLUS"
                  : quota?.plan === "pro"
                    ? "PRO"
                    : "FREE"}
              </small>
            </button>
            <button
              className={`nav-item ${section === "settings" ? "active" : ""}`}
              onClick={() => navigate("settings")}
            >
              <Settings size={19} />
              <span>个人设置</span>
            </button>
            {user?.admin && (
              <button className="nav-item" onClick={() => navigate("admin")}>
                <Shield size={19} />
                <span>管理后台</span>
              </button>
            )}
          </nav>
          <button
            className="account"
            onClick={() => (user ? navigate("settings") : setAuthOpen(true))}
          >
            <span className="avatar">
              {user ? user.email[0].toUpperCase() : <Leaf size={17} />}
            </span>
            <span>
              <strong>
                {user ? user.email.split("@")[0] : "你的灵感空间"}
              </strong>
              <small>
                {user
                  ? `${planName(quota?.plan)} · 私人空间`
                  : "登录后同步到云端"}
              </small>
            </span>
            {user ? <ChevronDown size={15} /> : <LogIn size={16} />}
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebar(true)}
            >
              <Menu size={21} />
            </button>
            <span>个人空间</span>
            <span className="slash">/</span>
            <strong>{selected ? "想法详情" : sectionTitles[section]}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${online ? "" : "offline"}`}>
              {online ? <Cloud size={15} /> : <CloudOff size={15} />}
              <span>
                {online ? (user ? "已连接服务" : "灵感，随时记下") : "当前离线"}
              </span>
            </span>
            <button
              className="btn subtle install-btn"
              onClick={async () => {
                if (install) {
                  await install.prompt();
                  setInstall(null);
                } else setInstallHelp(true);
              }}
            >
              <ArrowDownToLine size={15} /> 安装应用
            </button>
          </div>
        </header>
        {!online && (
          <div className="banner">
            <WifiOff size={16} />{" "}
            当前离线，仅显示此设备缓存。编辑内容会保存在此设备。
            <button
              className="text-btn"
              onClick={() => {
                setOnline(navigator.onLine);
                void syncAll();
              }}
            >
              立即同步
            </button>
          </div>
        )}
        {sw && (
          <div className="banner">
            新版本已就绪。
            <button
              className="text-btn"
              onClick={async () => {
                if (editor.current && !(await editor.current.flush())) return;
                if (user) {
                  const drafts = await storage.drafts(user.id);
                  const active = await api("/requests/active");
                  if (drafts.some((d) => d.dirty) || active) {
                    notify("请先同步草稿并等待 AI 任务完成");
                    return;
                  }
                }
                navigator.serviceWorker.addEventListener(
                  "controllerchange",
                  () => location.reload(),
                  { once: true },
                );
                sw.postMessage("ACTIVATE_UPDATE");
              }}
            >
              保存并更新
            </button>
          </div>
        )}
        {!ready ? (
          <div className="page-loading">
            <Spinner /> 正在打开你的空间
          </div>
        ) : selected ? (
          <Editor
            key={`${user?.id || "guest"}:${selected.id}`}
            ref={editor}
            initial={selected}
            user={user}
            config={config}
            online={online}
            onSaved={onSaved}
            onBack={() => navigate(section)}
            onLogin={() => setAuthOpen(true)}
            notify={notify}
            refreshQuota={refreshQuota}
            onConsent={() =>
              setUser((u) => (u ? { ...u, aiConsent: true } : u))
            }
          />
        ) : section === "subscription" ? (
          <Subscription
            user={user}
            config={config}
            quota={quota}
            onChanged={refreshQuota}
            onLogin={() => setAuthOpen(true)}
          />
        ) : section === "settings" ? (
          <SettingsPage
            user={user}
            online={online}
            onLogin={() => setAuthOpen(true)}
            onLogout={logout}
            notify={notify}
            onDeleted={async () => {
              if (user) await storage.clear(user.id);
              await storage.preference("lastUser", null);
              setUser(null);
              setSelected(null);
              setSection("all");
            }}
          />
        ) : section === "admin" ? (
          <AdminPage notify={notify} />
        ) : (
          <main className="workspace">
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span /> 每一个想法，都值得被记住
                </div>
                <h1>
                  {section === "all"
                    ? "给灵感一点生长的空间"
                    : sectionTitles[section]}
                </h1>
                <p>
                  {section === "all"
                    ? "随手记录，慢慢梳理。让脑海里的一闪而过，成为下一步的开始。"
                    : section === "trash"
                      ? "删除的想法保留 30 天，你可以随时恢复。"
                      : section === "archive"
                        ? "暂时收好这些想法，等一个合适的时机再出发。"
                        : "把值得反复思考的想法，留在触手可及的地方。"}
                </p>
              </div>
              <span className="date-pill">
                {new Intl.DateTimeFormat("zh-CN", {
                  month: "long",
                  day: "numeric",
                  weekday: "long",
                }).format(new Date())}
              </span>
            </div>
            {section === "all" && !query && !status && !tag && (
              <section className="capture-card">
                <div className="capture-content">
                  <span className="capture-kicker">
                    <Sparkles size={15} /> 留住此刻的灵光
                  </span>
                  <h2>现在，你在想什么？</h2>
                  <textarea
                    aria-label="快速记录想法"
                    placeholder="一个还不成熟的点子、一个想解决的问题，或一句突然想到的话……"
                    value={quick}
                    onChange={(e) => setQuick(e.target.value)}
                    rows={2}
                  />
                  <div className="capture-footer">
                    <span>
                      <span className="mini-dot" /> 不用想清楚，先记下来
                    </span>
                    <button
                      className="btn primary"
                      onClick={() => create(quick)}
                    >
                      开始记录 <ArrowRight size={17} />
                    </button>
                  </div>
                </div>
                <div className="capture-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="art-dot dot-one" />
                  <div className="art-dot dot-two" />
                  <div className="paper paper-back" />
                  <div className="paper paper-front">
                    <div className="paper-icon">
                      <Leaf size={32} />
                    </div>
                    <div className="paper-line long" />
                    <div className="paper-line" />
                    <div className="paper-line short" />
                    <span className="paper-check">
                      <Check size={13} />
                    </span>
                  </div>
                  <span className="art-spark">✦</span>
                  <span className="art-small-spark">✧</span>
                </div>
              </section>
            )}
            <div className="list-header">
              <div className="list-title">
                <h2>
                  {section === "all" ? "全部想法" : sectionTitles[section]}
                </h2>
                <span>{user ? total : "从一个小念头开始"}</span>
              </div>
              <div className="list-controls">
                <div className="search">
                  <Search size={16} />
                  <input
                    aria-label="搜索想法"
                    placeholder="搜索想法…"
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPage(0);
                    }}
                  />
                  {query && (
                    <button
                      aria-label="清除搜索"
                      className="icon-btn"
                      onClick={() => setQuery("")}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <button
                  className={`icon-btn filter-btn ${filterOpen ? "selected" : ""}`}
                  aria-label="筛选想法"
                  onClick={() => setFilterOpen(!filterOpen)}
                >
                  <SlidersHorizontal size={17} />
                </button>
                <div className="view-toggle">
                  <button
                    aria-label="网格视图"
                    className={layout === "grid" ? "selected" : ""}
                    onClick={() => setLayout("grid")}
                  >
                    <Grid2X2 size={16} />
                  </button>
                  <button
                    aria-label="列表视图"
                    className={layout === "list" ? "selected" : ""}
                    onClick={() => setLayout("list")}
                  >
                    <List size={18} />
                  </button>
                </div>
              </div>
            </div>
            <div className="filters">
              <button
                className={!status ? "active" : ""}
                onClick={() => {
                  setStatus("");
                  setPage(0);
                }}
              >
                全部
              </button>
              {statuses.map((s) => (
                <button
                  className={status === s ? "active" : ""}
                  key={s}
                  onClick={() => {
                    setStatus(s);
                    setPage(0);
                  }}
                >
                  <span className={`status-dot s${statuses.indexOf(s)}`} />
                  {s}
                </button>
              ))}
              {filterOpen && (
                <select
                  aria-label="按标签筛选"
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value);
                    setPage(0);
                  }}
                >
                  <option value="">全部标签</option>
                  {tags.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
            </div>
            {error ? (
              <div className="error-state">
                <CloudOff size={28} />
                <h3>暂时无法加载想法</h3>
                <p>{error}</p>
                <button className="btn secondary" onClick={load}>
                  重新加载
                </button>
              </div>
            ) : loading ? (
              <div className="page-loading">
                <Spinner /> 正在寻找灵感
              </div>
            ) : user && items.length ? (
              <>
                <div
                  className={`idea-grid ${layout === "list" ? "list-layout" : ""}`}
                >
                  {items.map((i, index) => (
                    <article
                      className="idea-card"
                      key={i.id}
                      tabIndex={0}
                      role="button"
                      aria-label={`打开想法：${i.title}`}
                      onClick={() => open(i)}
                      onKeyDown={(e) => {
                        if (
                          e.target === e.currentTarget &&
                          (e.key === "Enter" || e.key === " ")
                        ) {
                          e.preventDefault();
                          void open(i);
                        }
                      }}
                    >
                      <div className="idea-card-top">
                        <span
                          className={`idea-symbol ${["sage", "peach", "lavender", "sand"][index % 4]}`}
                        >
                          {["✳", "◈", "↗", "✧"][index % 4]}
                        </span>
                        <button
                          className={`icon-btn star ${i.favorite ? "starred" : ""}`}
                          aria-label={i.favorite ? "取消收藏" : "收藏想法"}
                          onClick={(e) => toggleStar(e, i)}
                          disabled={!online || !!i.deletedAt}
                        >
                          <Star
                            size={17}
                            fill={i.favorite ? "currentColor" : "none"}
                          />
                        </button>
                      </div>
                      <h3>{i.title}</h3>
                      <p className="idea-excerpt">{i.body}</p>
                      <div className="card-tags">
                        {i.tags.map((t) => (
                          <span key={t}># {t}</span>
                        ))}
                      </div>
                      <footer>
                        <span
                          className={`status-badge status-${statuses.indexOf(i.status)}`}
                        >
                          <span />
                          {i.status}
                        </span>
                        <time>{displayDate(i.updatedAt)}</time>
                      </footer>
                    </article>
                  ))}
                  {section === "all" && (
                    <button className="add-card" onClick={() => create()}>
                      <span>
                        <Plus size={25} />
                      </span>
                      <strong>下一个想法，会是什么？</strong>
                      <small>为新的可能，留一个位置</small>
                    </button>
                  )}
                </div>
                {total > 30 && (
                  <div className="pagination">
                    <button
                      className="btn secondary"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      上一页
                    </button>
                    <span>
                      第 {page + 1} 页 · 共 {total} 条
                    </span>
                    <button
                      className="btn secondary"
                      disabled={(page + 1) * 30 >= total}
                      onClick={() => setPage(page + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            ) : user ? (
              <Empty
                icon={section === "trash" ? <Trash2 /> : <Leaf />}
                title={
                  query || status || tag
                    ? "没有找到匹配的想法"
                    : section === "all"
                      ? "你的第一颗灵感，等你种下"
                      : `这里还没有${sectionTitles[section]}`
                }
              >
                <p>
                  {query || status || tag
                    ? "试着换个关键词，或清除筛选条件。"
                    : "一句话就足够开始，剩下的可以慢慢想。"}
                </p>
                {section === "all" && !query && !status && !tag && (
                  <button className="btn primary" onClick={() => create()}>
                    记下第一个想法 <Plus size={16} />
                  </button>
                )}
              </Empty>
            ) : (
              <>
                <div className="guest-note">
                  <span>不知道从哪里开始？看看这些灵感示例</span>
                  <span>示例内容，不属于你的个人记录</span>
                </div>
                <div className="idea-grid examples">
                  {examples.map((e) => (
                    <button
                      key={e.title}
                      className="idea-card example-card"
                      onClick={() => {
                        const i = blankIdea();
                        i.title = e.title;
                        i.body = e.body;
                        i.tags = [e.tag];
                        void open(i);
                      }}
                    >
                      <span className={`idea-symbol ${e.color}`}>{e.icon}</span>
                      <h3>{e.title}</h3>
                      <p className="idea-excerpt">{e.body}</p>
                      <footer>
                        <span className="example-tag">{e.tag}</span>
                        <span className="example-try">
                          试着聊聊 <ArrowUpRight size={14} />
                        </span>
                      </footer>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="workspace-foot">
              <Leaf size={13} />
              <span>想法无需完美，只需开始。</span>
              <span className="foot-line" />
            </div>
          </main>
        )}
      </div>
      <nav className="mobile-nav">
        <button
          className={section === "all" ? "active" : ""}
          onClick={() => navigate("all")}
        >
          <BookOpen size={20} />
          想法
        </button>
        <button
          className="mobile-add"
          aria-label="新建想法"
          onClick={() => create()}
        >
          <Plus size={24} />
        </button>
        <button
          className={section === "subscription" ? "active" : ""}
          onClick={() => navigate("subscription")}
        >
          <CreditCard size={20} />
          订阅
        </button>
        <button
          className={section === "settings" ? "active" : ""}
          onClick={() => navigate("settings")}
        >
          <Settings size={20} />
          我的
        </button>
      </nav>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button
            className="icon-btn"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {authOpen && (
        <Auth
          onClose={() => setAuthOpen(false)}
          onSuccess={async () => {
            await refreshSession();
            notify("登录成功");
          }}
        />
      )}
      {transfer && (
        <Modal title="保存刚才的灵感？" onClose={() => setTransfer(false)}>
          <p>
            将访客草稿「{guestDraft?.title || guestDraft?.body.slice(0, 25)}
            」保存到 {user?.email}。确认后只导入一次。
          </p>
          <div className="modal-actions">
            <button
              className="btn secondary"
              onClick={() => setTransfer(false)}
            >
              暂不导入
            </button>
            <button className="btn primary" onClick={importGuest}>
              保存到此账号
            </button>
          </div>
        </Modal>
      )}
      {installHelp && (
        <Modal title="把一念放在主屏幕" onClose={() => setInstallHelp(false)}>
          <div className="install-illustration">
            <Leaf size={38} />
          </div>
          <p>
            在 Chrome / Edge 中打开菜单，选择“安装应用”。iPhone 请在 Safari
            中点击“分享”，再选择“添加到主屏幕”。
          </p>
          <p className="muted">
            当前浏览器没有提供自动安装入口。开发模式下不注册离线缓存；构建并运行后可体验完整
            PWA。
          </p>
          <button
            className="btn primary full"
            onClick={() => setInstallHelp(false)}
          >
            知道了
          </button>
        </Modal>
      )}
    </div>
  );
}
