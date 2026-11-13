import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  CreditCard,
  Leaf,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { api, ApiError, errorText, fullDate } from "./lib";
import { Empty, Modal, Spinner } from "./ui";
import type { Quota, User } from "./types";
import "./billing.css";

export const planName = (id?: string) =>
  id === "standard" ? "标准版" : id === "pro" ? "专业版" : "免费版";
type Plan = {
  id: "standard" | "pro";
  version: string;
  name: string;
  priceFen: number;
  points: number;
};
type BillingInfo = {
  enabled: boolean;
  configured: boolean;
  h5Enabled: boolean;
  plans: Plan[];
  supportEmail: string | null;
  refundPolicyUrl: string | null;
  refundEnabled: boolean;
  missing: string[];
  activationRequired: boolean;
};
type Order = {
  id: string;
  plan: Plan;
  amount: number;
  status: string;
  entitlement: string;
  channel: "native" | "h5";
  paymentUrl: string | null;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
  startsAt?: string;
  endsAt?: string;
  renewal: boolean;
  lastError: string | null;
  refundStatus?: string;
  supportRequested: boolean;
  supportEmail?: string;
  supportReason?: string;
  userId?: string;
};
const states: Record<string, string> = {
  creating: "正在创建",
  pending: "待支付",
  unknown: "支付待确认",
  paid: "支付成功",
  closed: "已关闭",
  exception: "异常待核对",
  refund_pending: "退款处理中",
  refunded: "已退款",
};
const money = (amount: number) =>
  new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(
    amount / 100,
  );

export function Payments({
  view,
  user,
  quota,
  onLogin,
  onChanged,
}: {
  view: "plans" | "orders";
  user: User | null;
  quota: Quota | null;
  onLogin: () => void;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [channel, setChannel] = useState<"native" | "h5">("native");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [qr, setQr] = useState("");
  const [support, setSupport] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const requestKey = useRef(crypto.randomUUID());
  const checking = useRef(false);
  const lastState = useRef("");
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const inWechat = /MicroMessenger/i.test(navigator.userAgent);
  async function reload() {
    try {
      setInfo(await api("/billing"));
      if (user && view === "orders") setOrders((await api("/orders")).items);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void reload();
  }, [user?.id, view]);
  useEffect(() => {
    if (!user || view !== "plans") return;
    const id = new URLSearchParams(location.search).get("payment_order");
    if (id && /^[a-f0-9]{32}$/.test(id)) {
      api<Order>(`/orders/${id}`)
        .then((o) => {
          setOrder(o);
          void refresh(o.id);
        })
        .catch((e) => setError(errorText(e)));
    }
  }, [user?.id]);
  useEffect(() => {
    setQr("");
    if (order?.channel === "native" && order.paymentUrl) {
      let active = true;
      import("qrcode")
        .then((q) =>
          q.toDataURL(order.paymentUrl!, {
            width: 256,
            margin: 3,
            errorCorrectionLevel: "M",
          }),
        )
        .then((url) => {
          if (active) setQr(url);
        })
        .catch(() => setError("二维码暂时无法显示，请刷新订单重试"));
      return () => {
        active = false;
      };
    }
  }, [order?.paymentUrl]);
  async function refresh(id = order?.id) {
    if (!id || checking.current) return;
    checking.current = true;
    try {
      const next = await api<Order>(`/orders/${id}/refresh`, {});
      setOrder(next);
      if (lastState.current !== `${next.status}:${next.entitlement}`) {
        lastState.current = `${next.status}:${next.entitlement}`;
        onChanged();
        void reload();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      checking.current = false;
    }
  }
  useEffect(() => {
    if (
      !order ||
      !["creating", "pending", "unknown", "refund_pending"].includes(
        order.status,
      )
    )
      return;
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === "visible")
        void refresh(order.id);
    }, 6000);
    const focus = () => void refresh(order.id);
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [order?.id, order?.status]);
  function choose(p: Plan) {
    if (!user) {
      onLogin();
      return;
    }
    setError("");
    setMessage("");
    setAccepted(false);
    requestKey.current = crypto.randomUUID();
    setChannel(mobile && info?.h5Enabled && !inWechat ? "h5" : "native");
    setPlan(p);
  }
  async function checkout() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<Order>("/orders", {
        planVersion: plan.version,
        key: requestKey.current,
        channel,
        accepted,
      });
      setOrder(result);
      setPlan(null);
      void reload();
    } catch (e) {
      if (e instanceof ApiError && e.details?.orderId) {
        setOrder(await api(`/orders/${e.details.orderId}`));
        setPlan(null);
      }
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function resume() {
    if (!order) return;
    setBusy(true);
    setError("");
    try {
      setOrder(await api(`/orders/${order.id}/pay`, {}));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const dismiss = () => {
    if (busy) return;
    setOrder(null);
    setPlan(null);
    setSupport(false);
    setError("");
    const url = new URL(location.href);
    url.searchParams.delete("payment_order");
    history.replaceState(null, "", url);
  };
  return (
    <>
      {view === "plans" ? (
        <>
          {info && !info.enabled && (
            <div className="payment-setup">
              <CreditCard size={21} />
              <div>
                <strong>微信支付准备中</strong>
                <p>
                  商户审核与收款配置完成后开放购买。现在仍可免费记录、讨论和导出，暂不会产生付款。
                </p>
              </div>
            </div>
          )}
          <div className="plan-grid">
            {[
              { id: "free", name: "免费版", points: 60 },
              ...(["standard", "pro"] as const).map(
                (id) =>
                  info?.plans.find((p) => p.id === id) || {
                    id,
                    name: planName(id),
                    points: id === "standard" ? 2000 : 6000,
                  },
              ),
            ].map((p, index) => {
              const priced = "priceFen" in p ? (p as Plan) : null;
              const Icon = [Leaf, Sparkles, CheckCheck][index];
              return (
                <section
                  key={p.id}
                  className={`plan-card ${index === 1 ? "highlight" : ""}`}
                >
                  {index === 1 && (
                    <span className="plan-ribbon">持续思考的选择</span>
                  )}
                  <Icon size={24} />
                  <h3>{p.name}</h3>
                  <p>
                    {
                      [
                        "从第一个想法开始",
                        "为持续思考留出空间",
                        "让更多想法向前推进",
                      ][index]
                    }
                  </p>
                  <div className="plan-price">
                    {index === 0
                      ? "免费"
                      : priced
                        ? money(priced.priceFen)
                        : "价格待定"}
                    <small>
                      {index === 0
                        ? "长期可用"
                        : priced
                          ? "每订阅月 · 手动续费"
                          : "正式定价尚未公布"}
                    </small>
                  </div>
                  <div className="plan-points">
                    <strong>{p.points.toLocaleString()}</strong> 点 /{" "}
                    {index === 0 ? "自然月" : "订阅月"}
                    <span>
                      {priced ? "以购买时的套餐快照为准" : "联调建议额度"}
                    </span>
                  </div>
                  <ul>
                    <li>
                      <Check size={15} />
                      文字记录、搜索与管理
                    </li>
                    <li>
                      <Check size={15} />
                      Markdown 与全量导出
                    </li>
                    <li>
                      <Check size={15} />
                      快速 AI 讨论
                    </li>
                    <li>
                      {index > 0 ? (
                        <Check size={15} />
                      ) : (
                        <span className="dash">—</span>
                      )}
                      {index > 0 ? "快速 + 深度模式" : "深度模式未开放"}
                    </li>
                  </ul>
                  <button
                    className={`btn ${index === 1 ? "primary" : "secondary"} full`}
                    disabled={
                      index === 0
                        ? !!user
                        : !info?.enabled || !priced || !!quota?.nextPeriod
                    }
                    onClick={() =>
                      index === 0 ? onLogin() : priced && choose(priced)
                    }
                  >
                    {index === 0
                      ? user
                        ? quota?.plan === "free"
                          ? "当前套餐"
                          : "免费基础权益"
                        : "免费开始"
                      : !info?.enabled
                        ? "等待微信支付开通"
                        : quota?.nextPeriod
                          ? "已购买下一周期"
                          : quota?.plan && quota.plan !== "free"
                            ? "续费下一周期"
                            : "按月购买"}
                  </button>
                </section>
              );
            })}
          </div>
          <p className="billing-note">
            <ShieldCheck size={15} />
            按月购买，手动续费，不自动扣款。未用点数不结转。
          </p>
          {quota?.nextPeriod && (
            <p className="notice">
              下一周期：{planName(quota.nextPeriod.plan)}，
              {fullDate(quota.nextPeriod.startsAt)} 生效（北京时间），届时发放{" "}
              {quota.nextPeriod.total} 点。
            </p>
          )}
        </>
      ) : !user ? (
        <Empty icon={<CreditCard />} title="登录后查看订单">
          <button className="btn primary" onClick={onLogin}>
            登录 / 注册
          </button>
        </Empty>
      ) : orders.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>套餐 / 订单</th>
                <th>金额</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>
                    {o.plan.name}
                    <small className="order-id">{o.id}</small>
                  </td>
                  <td>{money(o.amount)}</td>
                  <td>
                    {states[o.status]}
                    {o.status === "paid" &&
                    o.startsAt &&
                    Date.parse(o.startsAt) > Date.now()
                      ? " · 待生效"
                      : ""}
                  </td>
                  <td>{fullDate(o.createdAt)}</td>
                  <td>
                    <button
                      className="text-btn"
                      onClick={() => {
                        setError("");
                        setMessage("");
                        setOrder(o);
                        if (
                          [
                            "pending",
                            "unknown",
                            "creating",
                            "refund_pending",
                          ].includes(o.status)
                        )
                          void refresh(o.id);
                      }}
                    >
                      查看订单
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={<CreditCard />} title="还没有订单">
          <p>
            {info?.enabled
              ? "购买或续费后，可以在这里查询支付和权益状态。"
              : "微信商户尚未开通，当前不会产生真实交易。"}
          </p>
        </Empty>
      )}
      {error && !order && !plan && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <Modal title="确认购买套餐" onClose={dismiss}>
          <div className="checkout-summary">
            <strong>{plan.name}</strong>
            <span>{money(plan.priceFen)} / 一个月</span>
          </div>
          <p>
            {quota?.plan && quota.plan !== "free"
              ? `本次为下一周期续费，预计 ${fullDate(quota.resetAt)} 生效，当前余额不会增加。`
              : "支付经服务端确认后开通一个订阅月。"}
            每周期 {plan.points.toLocaleString()}{" "}
            点，未用点数不结转，到期不自动扣款。
          </p>
          <label className="checkout-method">
            支付方式
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as "native" | "h5")}
            >
              <option value="native">微信扫码（使用另一台设备扫码）</option>
              {info?.h5Enabled && !inWechat && (
                <option value="h5">手机 H5（跳转微信）</option>
              )}
            </select>
          </label>
          {mobile && channel === "native" && (
            <p className="notice">
              当前方式需要另一台手机使用微信扫一扫。二维码不支持长按或相册识别；
              {inWechat
                ? "请在系统浏览器打开以使用已开通的 H5 支付。"
                : "H5 未开通时，建议在电脑上购买。"}
            </p>
          )}
          <label className="check-line">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
            />
            <span>
              我确认金额、服务周期，并已阅读
              {info?.refundPolicyUrl ? (
                <a href={info.refundPolicyUrl} target="_blank" rel="noreferrer">
                  退款政策
                </a>
              ) : (
                "退款政策"
              )}
              。
            </span>
          </label>
          {error && <p className="error">{error}</p>}
          <button
            className="btn primary full"
            disabled={busy || !accepted}
            onClick={checkout}
          >
            {busy ? <Spinner /> : <CreditCard size={17} />}确认下单 ·{" "}
            {money(plan.priceFen)}
          </button>
        </Modal>
      )}
      {order && (
        <Modal title="微信支付订单" onClose={dismiss}>
          <div className="checkout-summary">
            <strong>{order.plan.name}</strong>
            <span>{money(order.amount)}</span>
          </div>
          <p className="order-state" role="status">
            {states[order.status]}
            {order.status === "paid" && order.entitlement === "granted"
              ? " · 权益已处理"
              : ""}
          </p>
          <code className="order-id">{order.id}</code>
          {order.status === "pending" &&
            order.paymentUrl &&
            (order.channel === "native" ? (
              <div className="payment-qr">
                {qr ? (
                  <img
                    src={qr}
                    width={256}
                    height={256}
                    alt="使用微信扫一扫完成付款的支付二维码"
                  />
                ) : (
                  <Spinner />
                )}
                <p>请使用另一台设备上的微信扫一扫</p>
              </div>
            ) : inWechat ? (
              <p className="notice">
                请在 Safari、Chrome 等系统浏览器打开此订单，再使用 H5 支付。
              </p>
            ) : (
              <a
                className="btn primary full"
                href={order.paymentUrl}
                referrerPolicy="origin"
              >
                <Smartphone size={18} />
                打开微信付款
              </a>
            ))}
          {["pending", "unknown", "creating"].includes(order.status) && (
            <>
              <p className="muted">
                订单有效期至 {fullDate(order.expiresAt)}
                （北京时间）。离开支付页不会被视为支付成功。
              </p>
              <div className="modal-actions wrap">
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => refresh()}
                >
                  <RefreshCw size={15} />
                  我已支付，查询结果
                </button>
                {(!order.paymentUrl || order.channel === "h5") && (
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={resume}
                  >
                    重新获取支付入口
                  </button>
                )}
                <button
                  className="text-btn"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      !confirm(
                        "确认关闭这个未支付订单？将先向微信查询实际状态。",
                      )
                    )
                      return;
                    setBusy(true);
                    try {
                      setOrder(await api(`/orders/${order.id}/close`, {}));
                      void reload();
                      onChanged();
                    } catch (e) {
                      setError(errorText(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  关闭未支付订单
                </button>
              </div>
            </>
          )}
          {order.startsAt && order.endsAt && (
            <p className="notice">
              服务周期：{fullDate(order.startsAt)} 至 {fullDate(order.endsAt)}
              （北京时间）。
              {Date.parse(order.startsAt) > Date.now()
                ? "额度在新周期开始时发放。"
                : ""}
            </p>
          )}
          {order.status === "refunded" && (
            <p className="notice">
              该订单对应权益已撤销，已有想法仍可查看、编辑和导出。
            </p>
          )}
          {order.status === "refund_pending" && (
            <p className="notice">
              等待微信确认退款结果，实际到账时间以支付渠道为准。
            </p>
          )}
          {order.lastError && <p className="error">{order.lastError}</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {message && <p className="notice">{message}</p>}
          {order.status !== "closed" && (
            <div className="order-support">
              <button className="text-btn" onClick={() => setSupport(!support)}>
                {order.supportRequested
                  ? "补充订单问题"
                  : "订单有问题 / 申请退款支持"}
              </button>
              {support && (
                <>
                  <p className="muted">
                    提交问题供人工处理，不代表退款已批准。
                  </p>
                  <textarea
                    aria-label="订单问题说明"
                    placeholder="说明需要协助的事项…"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                  />
                  <button
                    className="btn secondary full"
                    disabled={busy || reason.trim().length < 3}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setOrder(
                          await api(`/orders/${order.id}/support`, { reason }),
                        );
                        setMessage("问题已记录，请保留订单编号。");
                        setSupport(false);
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    提交支持请求
                  </button>
                </>
              )}
              {info?.supportEmail && (
                <p>
                  <a
                    href={`mailto:${info.supportEmail}?subject=${encodeURIComponent("一念订单 " + order.id)}`}
                  >
                    联系支持：{info.supportEmail}
                  </a>
                </p>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

export function PaymentAdmin() {
  const [data, setData] = useState<{
    items: Order[];
    config: BillingInfo;
  } | null>(null);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState<Order | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const load = () =>
    api("/admin/payments")
      .then(setData)
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="ledger-panel">
      <div className="ledger-header">
        <h2>微信支付与订单</h2>
        <button className="text-btn" onClick={load}>
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      <div className="payment-admin-status">
        {data && (
          <>
            <strong>{data.config.enabled ? "收款已启用" : "收款未启用"}</strong>
            <p>
              退款接口：{data.config.refundEnabled ? "已启用" : "未启用"}
              。服务端仅按微信确认的结果发放或撤销权益。
            </p>
            {data.config.missing.length > 0 && (
              <p>待配置：{data.config.missing.join("、")}</p>
            )}
            {data.config.activationRequired && (
              <p>开通并完成联调后，才将 PAYMENT_ENABLED 设置为 true。</p>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>订单</th>
              <th>金额 / 状态</th>
              <th>支持请求</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((o) => (
              <tr key={o.id}>
                <td>
                  {o.plan.name}
                  <small className="order-id">{o.id}</small>
                </td>
                <td>
                  {money(o.amount)} · {states[o.status]}
                  <small className="order-id">{o.lastError}</small>
                </td>
                <td className="support-text">{o.supportReason || "—"}</td>
                <td>
                  <button
                    className="text-btn"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`/admin/payments/${o.id}/refresh`, {});
                        await load();
                      } catch (e) {
                        setError(errorText(e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    查单
                  </button>
                  {["paid", "exception", "refund_pending"].includes(
                    o.status,
                  ) && (
                    <button
                      className="text-btn danger-text"
                      disabled={!data.config.refundEnabled || busy}
                      onClick={() => {
                        setChosen(o);
                        setReason("");
                        setConfirmed(false);
                        setError("");
                      }}
                    >
                      整笔退款
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {chosen && (
        <Modal
          title="确认整笔原路退款"
          onClose={() => {
            if (!busy) setChosen(null);
          }}
        >
          <p>
            订单 {chosen.id}，退款金额 <strong>{money(chosen.amount)}</strong>
            。只有微信确认退款成功后，才撤销该订单对应的剩余权益。
          </p>
          <label>
            退款原因
            <input
              className="refund-reason"
              aria-label="退款原因"
              value={reason}
              maxLength={80}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            已核对订单和退款政策，确认执行真实退款。
          </label>
          {error && <p className="error">{error}</p>}
          <button
            className="btn danger full"
            disabled={busy || !confirmed || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/admin/payments/${chosen.id}/refund`, {
                  reason,
                  confirm: true,
                });
                setChosen(null);
                await load();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : "提交整笔退款"}
          </button>
        </Modal>
      )}
    </section>
  );
}
