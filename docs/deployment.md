# 服务器部署

访问地址：<https://zzhao.cc.cd/idea-notes/>。部署日期：2026-11-13。

## 当前配置

- Ubuntu 22.04；独立 Node.js 24.22.3 位于 `/opt/idea-notes/runtime`，没有替换系统 Node。
- systemd 服务：`idea-notes.service`，以专用 `idea-notes` 用户运行、开机启动、异常重启。
- 代码：`/opt/idea-notes/current` 指向 `/opt/idea-notes/releases/20261113-initial`。
- 数据库：`/var/lib/idea-notes/ideas.sqlite`，包含 WAL/SHM 文件时不要只复制主文件做在线备份。
- 密钥与配置：`/etc/idea-notes/app.env`，仅 root 可读，systemd 将其注入进程。
- 后端仅监听 `127.0.0.1:3102`。现有 Nginx 将 `/idea-notes/` 转发至该服务，复用已存在的 HTTPS 证书。
- Nginx 片段：`/etc/nginx/snippets/idea-notes.conf`，模板见 `deploy/nginx.conf`。原站点配置保存在 `/opt/deployment-backups/idea-notes-initial/sbti.conf`。
- `NODE_ENV=production`、`AUTH_MODE=password`；验证码入口关闭。支持注册、登录、修改密码及密码确认注销。账号 3–32 位，密码 12–128 个字符。
- 使用 scrypt（N=32768、r=8、p=3、随机盐）保存密码哈希。管理员账号通过运维脚本创建并在 `ADMIN_EMAILS` 中保留，公开注册不能抢占管理员名称。
- 快速和深度模式均配置为 `gpt-6-astra`，由用户指定的第三方接口提供。免费账号仍遵循现有套餐限制。
- 微信支付未开通，真实收款关闭。当前未提供邮箱找回密码，管理员初始密码单独交付；请在个人设置中修改。

## 更新与回滚

构建时设置 `APP_BASE_PATH=/idea-notes/`，然后执行 `npm ci`、`npm run build`。运行时也设置相同 `APP_BASE_PATH`，`APP_ORIGIN=https://zzhao.cc.cd` 不带路径。Nginx 去掉前缀后转发，浏览器资源、API、导出、Cookie、Manifest 和 Service Worker 使用此前缀。H5 支付将来也使用带前缀的返回页面及回调 URL。

建议上传到新的 release 目录，安装锁定依赖并保留旧版本，再切换 `current` 符号链接、重启服务。不要将本地 `.env`、数据库、node_modules 或测试输出覆盖至服务器。数据库迁移是追加式，当前版本为 3；回滚代码前应核对数据库兼容性。

```sh
systemctl status idea-notes --no-pager
journalctl -u idea-notes -n 100 --no-pager
systemctl restart idea-notes
curl -fsS http://127.0.0.1:3102/api/health
nginx -t && systemctl reload nginx
```

管理员初始化使用 `scripts/create-account.ts`，从标准输入读取包含 `account` 与 `password` 的 JSON。只对尚不存在的账号生效，不会覆盖已有密码。运行时指定正确 `DATABASE_PATH`，并保持文件属于服务用户。不得将密码写进命令行参数、源代码或 Git。

首次 Nginx 修改已保留其他应用配置。若仅撤回本站入口，从 HTTPS server 块移除 `include /etc/nginx/snippets/idea-notes.conf;`，执行 `nginx -t` 后 reload，再停止 `idea-notes`；不要覆盖之后可能更新过的整个共用站点配置。

生产机器已部署并不表示商业验收完成。独立异地备份与恢复演练、邮件找回、管理员强认证、服务商正式隐私条款、支付实单联调仍需后续补齐。
