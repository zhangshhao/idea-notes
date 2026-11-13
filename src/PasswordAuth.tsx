import { useState } from "react";
import { api, errorText } from "./lib";
import { Modal, Spinner } from "./ui";

export function PasswordAuth({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [register, setRegister] = useState(false);
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={register ? "创建你的账号" : "登录一念"} onClose={onClose}>
      <p className="muted">登录后保存与同步你的想法，随时接着思考。</p>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          if (register && password !== confirmation) {
            setError("两次输入的密码不一致");
            return;
          }
          setBusy(true);
          try {
            await api(`/auth/password/${register ? "register" : "login"}`, {
              account,
              password,
              accepted,
            });
            await onSuccess();
            onClose();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          账号
          <input
            aria-label="账号"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            minLength={3}
            maxLength={32}
            pattern="[a-zA-Z][a-zA-Z0-9_-]{2,31}"
            required
            placeholder="3–32 位字母、数字、下划线或短横线"
          />
        </label>
        <label>
          密码
          <input
            aria-label="密码"
            type="password"
            autoComplete={register ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={128}
            required
            placeholder="至少 12 个字符"
          />
        </label>
        {register && (
          <label>
            确认密码
            <input
              aria-label="确认密码"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              minLength={12}
              maxLength={128}
              required
            />
          </label>
        )}
        <label className="check-line">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span>
            我已阅读并同意{" "}
            <a
              href={`${import.meta.env.BASE_URL}legal.html#terms`}
              target="_blank"
              rel="noreferrer"
            >
              服务条款
            </a>{" "}
            与{" "}
            <a
              href={`${import.meta.env.BASE_URL}legal.html#privacy`}
              target="_blank"
              rel="noreferrer"
            >
              隐私说明
            </a>
          </span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary full" disabled={busy || !accepted}>
          {busy ? <Spinner /> : register ? "注册并登录" : "登录"}
        </button>
        <button
          type="button"
          className="text-btn"
          disabled={busy}
          onClick={() => {
            setRegister(!register);
            setError("");
            setPassword("");
            setConfirmation("");
          }}
        >
          {register ? "已有账号？去登录" : "还没有账号？注册"}
        </button>
        <small className="muted">请妥善保存密码，当前尚未提供邮箱找回。</small>
      </form>
    </Modal>
  );
}

export function PasswordSettings({
  notify,
}: {
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="settings-card">
      <h2>账号安全</h2>
      <div className="setting-row">
        <div>
          <strong>修改密码</strong>
          <p>修改后其他设备将退出登录。</p>
        </div>
        <button
          className="btn secondary"
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          修改密码
        </button>
      </div>
      {open && (
        <Modal
          title="修改密码"
          onClose={() => {
            setOpen(false);
            setCurrentPassword("");
            setNewPassword("");
            setConfirmation("");
          }}
        >
          <form
            className="form-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              if (newPassword !== confirmation) {
                setError("两次新密码不一致");
                return;
              }
              setBusy(true);
              try {
                await api("/auth/password/change", {
                  currentPassword,
                  newPassword,
                });
                setOpen(false);
                setCurrentPassword("");
                setNewPassword("");
                setConfirmation("");
                notify("密码已修改，其他设备已退出登录");
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              当前密码
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label>
              新密码
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            <label>
              确认新密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                minLength={12}
                maxLength={128}
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="btn primary full" disabled={busy}>
              {busy ? <Spinner /> : "保存新密码"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
