import { useState } from "react";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { api, errorText } from "./lib";
import { Modal, Spinner } from "./ui";
export function Auth({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [sent, setSent] = useState(false);
  const [devCode, setDevCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send() {
    setBusy(true);
    setError("");
    try {
      const r = await api("/auth/code", { email });
      setSent(true);
      setDevCode(r.developmentCode || "");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", { email, code, accepted });
      await onSuccess();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="给想法一个安放的地方" onClose={onClose}>
      <p className="muted">登录后保存与同步你的想法，随时接着思考。</p>
      <form onSubmit={login} className="form-stack">
        <label>
          邮箱地址
          <div className="input-icon">
            <Mail size={18} />
            <input
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@example.com"
              required
              onChange={(e) => {
                setEmail(e.target.value);
                setSent(false);
                setDevCode("");
              }}
            />
          </div>
        </label>
        <label>
          验证码
          <div className="inline">
            <input
              aria-label="验证码"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              maxLength={6}
              placeholder="6 位验证码"
              required
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="btn secondary"
              type="button"
              disabled={busy || !email}
              onClick={send}
            >
              {sent ? "重新获取" : "获取验证码"}
            </button>
          </div>
        </label>
        {devCode && (
          <div className="notice">
            开发环境 · 验证码 <strong>{devCode}</strong>
            <button
              type="button"
              className="text-btn"
              onClick={() => setCode(devCode)}
            >
              填入
            </button>
            <small>未发送真实邮件，仅用于本地联调。</small>
          </div>
        )}
        <label className="check-line">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            我已阅读并同意
            <a href="/legal.html#terms" target="_blank" rel="noreferrer">
              服务条款
            </a>
            与
            <a href="/legal.html#privacy" target="_blank" rel="noreferrer">
              隐私说明
            </a>
          </span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="btn primary full"
          disabled={busy || !accepted || !sent}
        >
          {busy ? (
            <Spinner />
          ) : (
            <>
              登录 / 注册 <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
      <p className="privacy-foot">
        <ShieldCheck size={14} /> 想法默认私有，内容始终由你掌控
      </p>
    </Modal>
  );
}
