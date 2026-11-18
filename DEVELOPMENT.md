# DEVELOPMENT.md — 架构、测试与发布（维护者/贡献者）

本文件写给开发者。普通用户请回 [README](README.md)。

## 架构

```
status.deepseek.com (Flashcat / Next.js SSR flight)
        │  HTTP GET（宿主进程，超时 + 2 MiB 上限）
        ▼
lib/index.js  ──►  lib/parser.js  ──►  内存快照（last good snapshot）
        │
        │ 同源路由  GET /deepseek-status/current
        ▼
lib/client.js（浏览器半区）
   ├─ 每 30s 拉一次上面这个路由
   ├─ 注册会话头部槽 conversation.session.header.utilities：状态点 + 面板
   └─ 注册设置卡：plugins.bundle.config / plugins.row.config（key 为包名 / `包名#行id`）
```

## 文件职责

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半区：注册路由、抓取上游、解析、内存快照、配置 schema（`statusUrl` / `pollIntervalMs` / `timeoutMs`，均 `.volatile()`）、轮询定时器、刷新加锁、`statusUrl` 校验、2 MiB 上限 |
| `lib/parser.js` | 从状态页 HTML 的 Next.js flight 负载里按字段名提取 overall/components/incidents/uptime |
| `lib/client.js` | 浏览器半区：会话头部挂件与面板、设置卡片（经 `ctx.reflect.get("configForms")` 可选读取）、`pageHref()` 链接校验 |
| `cordis.patch.yml` | 插件注册行（`id: deepseek-status`、`name: @mengls1620/dsh-deepseek-status`、默认 config） |
| `test/host.test.mjs` | 宿主侧：抓取/解析/快照/刷新加锁/配置变化/2 MiB 上限 |
| `test/schema.test.mjs` | Config schema 默认值与范围（依赖 `@deepseek-ai/schemastery`） |
| `test/client.test.mjs` | 浏览器侧纯函数：inject 列表、`pageHref`、设置服务可选 |

## 关键实现说明

1. **设置卡是两段式**：DSH 0.2 不会按 schema 自动生成表单。宿主侧字段必须声明 `.volatile()` 才会被设置服务投影；浏览器侧必须自己注册卡片，key 与插件页拼的完全一致：
   - `plugins.bundle.config` → `@mengls1620/dsh-deepseek-status`
   - `plugins.row.config` → `@mengls1620/dsh-deepseek-status#deepseek-status`

   0.1.9 起 `configForms` 为**可选**：用 `ctx.reflect.get("configForms")` 读取；Cordis 对「未注入服务」的直接读取会抛错，因此不能写 `ctx.configForms`。
2. **刷新加锁**：同一时刻只允许一次上游抓取；期间触发的刷新合并成一次 pending；用递增 seq 丢弃过期结果，旧响应不覆盖新快照。
3. **配置变化**：监听 `loader/volatile-update`，只处理本插件的行；`statusUrl`/`timeoutMs` 变化立即刷新，`pollIntervalMs` 变化重挂定时器，其它更新不动作。
4. **安全边界**：`statusUrl` 只接受绝对 `http(s)`；响应体解压后最多读 2 MiB（正常约 216 KiB），超限按失败处理并保留旧快照。
5. **失败语义**：抓取/解析失败保留最后一次成功快照，路由返回 `error` 字段，面板显示「更新于 X 分钟前」。

## 本地开发

```sh
npm test          # node --experimental-vm-modules --test（26 项）
npm run check     # 三个 lib 的 node --check + 全部测试
npm pack          # 打 tarball；prepack 会先跑 check
```

测试依赖 `@deepseek-ai/schemastery`（devDependency，钉精确版本 3.19.0）；未安装时 schema 测试会自动跳过，其余测试照常运行。**不提交 lockfile**（仓库约定，CI 用 `--no-package-lock`）。

## 发布链路（trusted publishing）

1. 修改 `package.json` 版本（如 0.1.9 → 0.1.10），更新 `CHANGELOG.md` 与 README 兼容表；
2. 本地 `npm run check` + `npm pack --dry-run`；
3. 提交并 push 到 `MengLs1620/dsh-deepseek-status` 的 `main`；
4. 在 GitHub 上创建 **Release**（tag 与版本一致，如 `v0.1.10`）；
5. `.github/workflows/publish.yml` 被 release 事件触发：安装 devDependencies → 校验 schemastery 可加载 → `npm run check` → `npm publish --provenance --access public --ignore-scripts`；
6. 验证 registry：`npm view @mengls1620/dsh-deepseek-status version`，并用 `node <npm-cli> pack` 或在干净目录 `npm install` 验证 tarball；首次发布后 npm 会短暂建 `0.0.0-stage` 占位并在约 2 分钟内完成处理。

npm trusted publisher 已配置在 npm 包 Settings → Trusted Publisher（GitHub Actions：`MengLs1620/dsh-deepseek-status` + `publish.yml`），不再需要 token。

## 版本与兼容

- 包名从 0.1.6 起为 `@mengls1620/dsh-deepseek-status`；浏览器模块 id 必须等于 package name（DSH client-modules 硬约束）。
- 0.1.9 验证环境：Windows + DSH 0.2.2-rc.3（schemastery 3.19.0、cordis 4.1.0）。
- 发版前如 DSH 有新版，先跑 `test` + 本机安装重启验证（挂件/面板/设置卡 + 改一次配置保存），再发布。
