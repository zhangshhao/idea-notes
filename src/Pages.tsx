import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  CloudOff,
  ExternalLink,
  Leaf,
  LogOut,
  RefreshCw,
  Shield,
  Wallet,
} from "lucide-react";
import { api, errorText, fullDate, storage, download } from "./lib";
import { Empty, Modal, Spinner } from "./ui";
import type { Config, Quota, User } from "./types";
import { Payments, PaymentAdmin, planName } from "./Billing";
import { PasswordSettings } from "./PasswordAuth";
export function Subscription({
  user,
  config,
  quota,
  onLogin,
  onChanged,
}: {
  user: User | null;
  config: Config;
  quota: Quota | null;
  onLogin: () => void;
  onChanged: () => void;
}) {
  const [ledger, setLedger] = useState<any[]>([]);
  const [tab, setTab] = useState<"ledger" | "orders">("ledger");
  const [error, setError] = useState("");
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    if (user)
      api("/ledger")
        .then(setLedger)
        .catch((e) => setError(errorText(e)));
  }, [user, quota]);
  const names: Record<string, string> = {
    grant: "周期发放",
    reserve: "请求预占",
    release: "释放预占",
    consume: "实际消耗",
    compensation: "额度补偿",
    revoke: "退款撤销",
  };
  return (
    <main className="workspace secondary-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> 把额度用在值得的思考上
          </div>
          <h1>为想法，多一点可能</h1>
          <p>记录始终免费。选择适合你的节奏，和 AI 深入讨论。</p>
        </div>
      </div>
      <section className="quota-hero">
        <div>
          <span className="pill">当前套餐 · {planName(quota?.plan)}</span>
          <h2>每一次讨论，都清清楚楚</h2>
          <p>
            {config.aiDemo
              ? "当前为本地演示额度，非真实付费权益。"
              : quota?.plan && quota.plan !== "free"
                ? "付费周期按北京时间订阅月计算。"
                : "免费额度按北京时间自然月刷新。"}
            <br />
            额度用完后，仍可记录、编辑与导出。
          </p>
          <span className="quota-reset">
            {quota?.plan && quota.plan !== "free"
              ? "本周期到期："
              : "下次刷新："}
            {quota ? fullDate(quota.resetAt) + "（北京时间）" : "登录后查看"}
          </span>
        </div>
        <div className="quota-ring">
          <svg viewBox="0 0 160 160">
            <circle cx="80" cy="80" r="68" />
            <circle
              className="quota-value"
              cx="80"
              cy="80"
              r="68"
              strokeDasharray={`${((quota?.available ?? 60) / (quota?.total || 60)) * 427} 427`}
            />
          </svg>
          <div>
            <strong>{quota?.available ?? "—"}</strong>
            <span>可用 AI 点数</span>
          </div>
        </div>
        <div className="quota-details">
          <div>
            <span>周期总额</span>
            <strong>
              {quota?.total ?? 60}
              <small> 点</small>
            </strong>
          </div>
          <div>
            <span>已使用</span>
            <strong>
              {quota?.used ?? 0}
              <small> 点</small>
            </strong>
          </div>
          <div>
            <span>处理中预占</span>
            <strong>
              {quota?.reserved ?? 0}
              <small> 点</small>
            </strong>
          </div>
        </div>
      </section>
      <div className="section-title">
        <h2>给不同阶段的想法，合适的支持</h2>
        <button className="text-btn" onClick={() => setDetail(true)}>
          点数如何计算？ <ExternalLink size={13} />
        </button>
      </div>
      <Payments
        view="plans"
        user={user}
        quota={quota}
        onLogin={onLogin}
        onChanged={onChanged}
      />
      <section className="ledger-panel">
        <div className="ledger-header">
          <div className="plain-tabs">
            <button
              className={tab === "ledger" ? "active" : ""}
              onClick={() => setTab("ledger")}
            >
              额度明细
            </button>
            <button
              className={tab === "orders" ? "active" : ""}
              onClick={() => setTab("orders")}
            >
              我的订单
            </button>
          </div>
          <span>北京时间</span>
        </div>
        {error ? (
          <p className="error">{error}</p>
        ) : !user ? (
          <Empty icon={<Wallet />} title="登录后查看你的额度">
            <button className="btn primary" onClick={onLogin}>
              登录 / 注册
            </button>
          </Empty>
        ) : tab === "orders" ? (
          <Payments
            view="orders"
            user={user}
            quota={quota}
            onLogin={onLogin}
            onChanged={onChanged}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>变动事项</th>
                  <th>点数</th>
                  <th>时间</th>
                  <th>请求编号</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <span className={`ledger-kind ${l.kind}`} />
                      {names[l.kind] || l.kind}
                    </td>
                    <td
                      className={
                        ["grant", "release"].includes(l.kind) ? "positive" : ""
                      }
                    >
                      {["grant", "release"].includes(l.kind) ? "+" : "−"}
                      {l.amount}
                    </td>
                    <td>{fullDate(l.createdAt)}</td>
                    <td>
                      <code title={l.requestId}>
                        {l.requestId.startsWith("grant:")
                          ? "周期额度"
                          : l.requestId.slice(0, 8)}
                      </code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {detail && (
        <Modal title="AI 点数如何计算" onClose={() => setDetail(false)}>
          <p>
            快速模式：输入 tokens ÷ 1,000 × 1 + 输出 tokens ÷ 1,000 ×
            4，向上取整，成功最低 1 点。
          </p>
          <p>
            例如输入 2,000 tokens、输出 500 tokens，消耗 4 点。AI
            点数不等于固定对话次数或人民币。
          </p>
          <p className="notice">
            发送前确认预占上限，完成后释放多余预占。失败不扣点，主动停止且有有效输出时按实际结算。
          </p>
        </Modal>
      )}
    </main>
  );
}
export function SettingsPage({
  authMode,
  user,
  online,
  onLogin,
  onLogout,
  notify,
  onDeleted,
}: {
  authMode?: string;
  user: User | null;
  online: boolean;
  onLogin: () => void;
  onLogout: () => void;
  notify: (s: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const [cache, setCache] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [chat, setChat] = useState(false);
  const [trash, setTrash] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (user)
      storage
        .preference(`offline:${user.id}`)
        .then((v) => setCache(v !== false));
  }, [user]);
  async function clearCache() {
    if (!user) return;
    try {
      await storage.clearCache(user.id);
      notify("已清除离线阅读缓存，未同步草稿仍会保留");
    } catch (e) {
      notify(errorText(e));
    }
  }
  return (
    <main className="workspace secondary-page settings-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> 由你掌控的私人空间
          </div>
          <h1>个人设置</h1>
          <p>管理账号、设备缓存与属于你的数据。</p>
        </div>
      </div>
      <section className="settings-card profile-card">
        <span className="profile-avatar">
          {user ? user.email[0].toUpperCase() : <Leaf size={30} />}
        </span>
        <div>
          <h2>{user?.email || "欢迎来到一念"}</h2>
          <p>{user ? "想法默认私有" : "登录后，在不同设备接着思考。"}</p>
        </div>
        <button
          className="btn secondary"
          disabled={!!user && !online}
          onClick={user ? onLogout : onLogin}
        >
          {user ? (
            <>
              <LogOut size={16} />
              退出登录
            </>
          ) : (
            "登录 / 注册"
          )}
        </button>
      </section>
      <section className="settings-card">
        <h2>
          <CloudOff size={19} /> 离线与设备
        </h2>
        <div className="setting-row">
          <div>
            <strong>允许离线阅读</strong>
            <p>仅缓存最近打开的 20 条想法，不缓存完整对话或订单。</p>
          </div>
          <button
            role="switch"
            aria-checked={cache}
            aria-label="允许离线阅读"
            className={`switch ${cache ? "on" : ""}`}
            disabled={!user}
            onClick={async () => {
              if (!user) return;
              await storage.preference(`offline:${user.id}`, !cache);
              if (cache) await storage.clearCache(user.id);
              setCache(!cache);
              notify(
                cache ? "已关闭离线阅读，编辑草稿仍会暂存" : "已开启离线阅读",
              );
            }}
          >
            <span />
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>清除本地阅读缓存</strong>
            <p>不删除服务端数据，也不会清除未同步的编辑草稿。</p>
          </div>
          <button
            className="btn secondary"
            disabled={!user}
            onClick={clearCache}
          >
            清除缓存
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>备份未同步草稿</strong>
            <p>下载这个账号在当前设备上尚未同步的记录。</p>
          </div>
          <button
            className="btn secondary"
            disabled={!user}
            onClick={async () => {
              if (user)
                download(
                  "未同步草稿.json",
                  JSON.stringify(await storage.drafts(user.id), null, 2),
                  "application/json",
                );
            }}
          >
            下载备份
          </button>
        </div>
      </section>
      <section className="settings-card">
        <h2>
          <ArrowDownToLine size={19} /> 数据与隐私
        </h2>
        <div className="setting-row">
          <div>
            <strong>导出所有想法</strong>
            <p>ZIP 内包含逐条 Markdown 和结构化 JSON，便于备份与迁移。</p>
          </div>
          <button
            className="btn secondary"
            disabled={!user || !online}
            onClick={() => setExportOpen(true)}
          >
            导出数据
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>服务条款与隐私说明</strong>
            <p>了解数据范围、第三方 AI 与本地开发版限制。</p>
          </div>
          <a
            className="text-btn"
            href={`${import.meta.env.BASE_URL}legal.html`}
            target="_blank"
            rel="noreferrer"
          >
            查看说明 <ExternalLink size={14} />
          </a>
        </div>
      </section>
      {user && online && authMode === "password" && (
        <PasswordSettings notify={notify} />
      )}
      <section className="settings-card danger-zone">
        <h2>账号注销</h2>
        <div className="setting-row">
          <div>
            <strong>删除账号与个人内容</strong>
            <p>
              需要重新验证{authMode === "password" ? "密码" : "邮箱"}
              ；删除后无法恢复。建议先导出数据。
            </p>
          </div>
          <button
            className="btn danger-outline"
            disabled={!user || !online}
            onClick={() => setDeleting(true)}
          >
            注销账号
          </button>
        </div>
      </section>
      <p className="settings-version">一念 IDEA NOTES · v0.2.0</p>
      {exportOpen && (
        <Modal title="导出全部想法" onClose={() => setExportOpen(false)}>
          <p>默认不包含回收站与对话。仅导出当前登录账号的数据。</p>
          <label className="check-line">
            <input
              type="checkbox"
              checked={chat}
              onChange={(e) => setChat(e.target.checked)}
            />
            包含对话记录
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={trash}
              onChange={(e) => setTrash(e.target.checked)}
            />
            包含回收站
          </label>
          <button
            className="btn primary full"
            onClick={() => {
              location.href = `${import.meta.env.BASE_URL}api/export?chat=${chat}&trash=${trash}`;
              setExportOpen(false);
            }}
          >
            下载 ZIP
          </button>
        </Modal>
      )}
      {deleting && (
        <Modal title="确认注销账号" onClose={() => setDeleting(false)}>
          <p>
            账号 {user?.email}{" "}
            的想法、讨论、整理与行动将永久删除。如有支付订单，需先联系支持处理退款、服务期和交易记录保留。
          </p>
          <div className="form-stack">
            <label>
              {authMode === "password" ? "确认账号密码" : "重新验证邮箱"}
              <div className="inline">
                <input
                  aria-label={
                    authMode === "password" ? "注销密码" : "注销验证码"
                  }
                  type={authMode === "password" ? "password" : "text"}
                  autoComplete={
                    authMode === "password"
                      ? "current-password"
                      : "one-time-code"
                  }
                  value={code}
                  placeholder={
                    authMode === "password" ? "输入当前密码" : "6 位验证码"
                  }
                  onChange={(e) => setCode(e.target.value)}
                />
                {authMode !== "password" && (
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const r = await api("/auth/code", {
                          email: user?.email,
                        });
                        setDevCode(r.developmentCode || "");
                        notify("验证码已生成或发送");
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    获取验证码
                  </button>
                )}
              </div>
            </label>
            {devCode && <p className="notice">开发验证码：{devCode}</p>}
            {error && <p className="error">{error}</p>}
            <button
              className="btn danger full"
              disabled={
                busy ||
                (authMode === "password" ? code.length < 12 : code.length !== 6)
              }
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await api(
                    "/account/delete",
                    authMode === "password" ? { password: code } : { code },
                  );
                  await onDeleted();
                  notify("账号及个人内容已删除");
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              验证并永久注销
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
export function AdminPage({ notify }: { notify: (s: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const load = () =>
    api("/admin")
      .then(setData)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="workspace secondary-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> 运行概览与审计
          </div>
          <h1>管理后台</h1>
          <p>仅显示运营元数据，不展示用户想法正文、对话或密钥。</p>
        </div>
        <button className="btn secondary" onClick={load}>
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      {error ? (
        <p className="error">{error}</p>
      ) : !data ? (
        <Spinner />
      ) : (
        <>
          <PaymentAdmin />
          <section className="admin-stats">
            <div>
              <span>已注册用户</span>
              <strong>{data.users.length}</strong>
            </div>
            <div>
              <span>最近 AI 请求</span>
              <strong>{data.requests.length}</strong>
            </div>
            <div>
              <span>服务状态</span>
              <strong className="text-green">
                {data.aiPaused ? "已暂停" : "运行中"}
              </strong>
            </div>
          </section>
          <section className="settings-card">
            <h2>
              <Shield size={18} /> AI 保护开关
            </h2>
            <p className="muted">
              暂停后拒绝新请求，记录与导出继续可用。每次变更都写入审计日志。
            </p>
            <div className="inline">
              <input
                aria-label="操作原因"
                value={reason}
                placeholder="填写操作原因（至少 3 个字）"
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                className="btn secondary"
                disabled={reason.trim().length < 3}
                onClick={async () => {
                  try {
                    await api("/admin/ai-paused", {
                      paused: !data.aiPaused,
                      reason,
                    });
                    setReason("");
                    await load();
                    notify("配置已更新并记录审计");
                  } catch (e) {
                    notify(errorText(e));
                  }
                }}
              >
                {data.aiPaused ? "恢复 AI" : "暂停新请求"}
              </button>
            </div>
          </section>
          <section className="ledger-panel">
            <div className="ledger-header">
              <h2>用户概览</h2>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>邮箱</th>
                    <th>想法数量</th>
                    <th>注册时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.users.map((u: any) => (
                    <tr key={u.id}>
                      <td>{u.email}</td>
                      <td>{u.ideas}</td>
                      <td>{fullDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="ledger-panel">
            <div className="ledger-header">
              <h2>最近请求</h2>
              <span>最多 100 条</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>请求</th>
                    <th>状态</th>
                    <th>模式</th>
                    <th>预占 / 消耗</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {data.requests.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <code>{r.id.slice(0, 8)}</code>
                      </td>
                      <td>{r.state}</td>
                      <td>{r.mode}</td>
                      <td>
                        {r.maximum} / {r.charged ?? "处理中"}
                      </td>
                      <td>{fullDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section className="ledger-panel">
            <div className="ledger-header">
              <h2>操作审计</h2>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>操作</th>
                    <th>操作者</th>
                    <th>时间</th>
                    <th>原因</th>
                  </tr>
                </thead>
                <tbody>
                  {data.audit.map((a: any) => (
                    <tr key={a.id}>
                      <td>{a.action}</td>
                      <td>{a.actor.slice(0, 8)}</td>
                      <td>{fullDate(a.created_at)}</td>
                      <td>{JSON.parse(a.data).reason || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
