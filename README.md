# Clash Subscription Worker

部署在 Cloudflare Workers 上的 Mihomo / Clash 订阅服务。它会生成完整配置，也可以反代 Provider 订阅并只保留可用节点。

## 准备

需要 Node.js 20 或更高版本，以及一个 Cloudflare 账户。

```bash
npm install
npx wrangler login
```

## Wrangler 配置

打开 `wrangler.jsonc`：

- 把 `name` 改成你的 Worker 名称。
- 两个 `namespace_id` 不能相同，也不要和账户内其他 Worker 共用。
- `simple.limit` 和 `simple.period` 分别是限流次数和周期。

`SUB_RATE_LIMITER`、`PROXY_RATE_LIMITER` 这两个 binding 名称不能改。

## 订阅配置

```bash
cp private.config.example.yaml private.config.yaml
chmod 600 private.config.yaml
openssl rand -hex 32
```

把 `openssl` 输出的 token 填入 `private.config.yaml`，然后配置上游：

```yaml
runtime:
  # token 错误时跳转到这里
  decoy-url: "https://decoy.example.com/"
  # 1000 到 30000 毫秒
  upstream-timeout-ms: 15000
  # 0 到 21600 秒，0 表示关闭缓存
  provider-cache-ttl-seconds: 1800

subscription:
  name: "My Subscription"
  # 以下三项可删除
  update-interval-hours: 24
  userinfo: "upload=0; download=0; total=1099511627776; expire=1893456000"
  support-url: "https://support.example.com/"

tokens:
  - "REPLACE_WITH_OPENSSL_OUTPUT"

providers:
  airport:
    url: "https://provider.example.com/sub?token=REPLACE_ME"
    prefix: "[Airport]"
    direct: false
    user-agent: "Mihomo/1.0"

  trusted:
    url: "https://another-provider.example.com/sub?token=REPLACE_ME"
    prefix: "[Trusted]"
    direct: true
```

示例里的 token 和 `example.com` 地址故意无法通过构建，部署前全部替换。

配置限制：

- `tokens` 可以填写 1 到 100 个 token，每个 24 到 256 个字符。
- `subscription.name` 最长 128 个字符。
- `update-interval-hours` 可填 1 到 168；`userinfo` 必须加引号，并包含 `upload` 和 `download`；`support-url` 必须是公网 HTTPS 地址。
- Provider 名称必须以小写字母或数字开头，可包含 `a-z`、`0-9`、`_`、`-`，最长 32 个字符。
- Provider URL 必须是公网 HTTPS 地址，不能包含 fragment 或 `user:pass@host`。
- `prefix` 最长 64 个字符，可以留空。
- 可选字段不用时删除整行，不要填写空值。

| `direct` | 行为 |
|---|---|
| `false` | Worker 请求并清洗上游，订阅中不会出现上游 URL；可设置 `user-agent` |
| `true` | 客户端直接请求上游，订阅中会包含上游 URL；不能设置 `user-agent` |

## 检查和部署

```bash
npm run check
npm run deploy
```

这两个命令都会重新编译配置，不需要提前运行 `npm run build`。本地调试使用：

```bash
npm run dev
```

## 订阅地址

部署完成后，把 Worker 域名和配置中的 token 填入：

```text
https://<Worker 域名>/sub?token=<token>
```

浏览器打开会进入配置页，Mihomo / Clash 使用同一地址会拿到 YAML。需要固定返回格式时添加：

```text
&format=html
&format=yaml
```

配置页可以选择 tag。也可以直接写在地址里：

```text
https://<Worker 域名>/sub?token=<token>&tag=router&tag=linux
```

| 路由 | 用途 |
|---|---|
| `GET /sub?token=...` | 配置页或 Clash YAML |
| `GET /proxy/<provider>?token=...` | 访问 `direct: false` 的 Provider |
| `GET /healthz` | 健康检查，返回 `ok` |

## 修改 Clash 模板

Clash 配置模板在 `src/clash-template.yaml`。tag 条件写法：

```yaml
{{if tag=router}}
allow-lan: true
{{else}}
allow-lan: false
{{/if}}
```

`p: &p` 下的 `exclude-type` 和 `filter` 也用于清洗 Provider 节点。修改后运行 `npm run check`。

## 生成文件和私密配置

- `private.config.yaml` 包含 token 和上游 URL，已经加入 `.gitignore`。
- `src/generated/` 由构建脚本生成，不要手动修改。
- `worker-configuration.d.ts` 由 `npm run cf-typegen` 生成，只用于 TypeScript 类型检查。

构建产物只保存 token 的 SHA-256 摘要，但 Provider URL 会进入 Worker bundle。CI 部署时需要先恢复 `private.config.yaml`，再执行 `chmod 600 private.config.yaml`。

## 许可证

本项目采用 [GNU AGPL v3 或更高版本](LICENSE)。
