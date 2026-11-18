# AGENTS.md — 给 AI 助手的安装/验证/回滚 SOP

本文件写给 **AI 助手**：当用户让你帮忙安装、升级、验证或排查 `@mengls1620/dsh-deepseek-status` 时，按下面步骤操作。原则：**先确认、再动手；先备份、再修改；装完必须重启并验证**。

## 0. 先确认

- 目标 DSH 版本：**0.2.x**（本插件验证到 0.2.2-rc.3；0.1.x 未实测）。
- 确认用户的 DSH profile 目录（桌面端常见 `~/.dsh/profiles/desktop`，Web 端可能是 `web`）。
- 检查是否装过旧包：`dsh plugin --profile <profile> list`，或看 profile 的 `package.json` 依赖里有没有 **非 scoped** 的 `dsh-deepseek-status`。新旧包不能共存（同路由、同行 id）。
- 工作区外（profile、安装目录）修改前，先备份 `package.json`、`cordis.patch.yml`，并告知用户回滚方式。

## 1. 安装

桌面端优先：让用户打开侧栏「插件」→ 搜索 `@mengls1620/dsh-deepseek-status` → 安装。

命令行：

```sh
dsh plugin --profile <profile> add @mengls1620/dsh-deepseek-status
```

从旧包迁移（必须先卸旧包）：

```sh
dsh plugin --profile <profile> remove dsh-deepseek-status
```

> ⚠️ 装完**必须提示用户完全退出并重新打开 DSH**，宿主代码不会热加载；只刷新页面不够。

## 2. 验证（按顺序做，不要只看界面）

1. **宿主路由**：确认 GUI 端口（从 DSH 运行时信息或 `netstat` 查真实端口，不要猜），然后
   `curl -s http://127.0.0.1:<端口>/deepseek-status/current` 应返回 **200**，JSON 含 `overall`、`components`、`fetchedAt`、`statusUrl`、`error`。
2. **界面**：会话头部出现状态点；点击能展开面板并显示组件数据与更新时间。
3. **配置**：插件页设置卡片三个字段可保存；把轮询间隔改一次再保存，确认面板「更新于」在下个周期刷新，然后改回原值。

## 3. 常见失败与处理

- **插件页显示「运行中」，但挂件/面板/设置卡全部消失**：多为浏览器半区在加载时抛错。
  先查路由是否为 200：200 → 浏览器半区问题（检查 `lib/client.js` 版本与 `error` 日志）；非 200 → 宿主半区问题。
- **升级后行为异常**：确认 profile 里依赖版本与实际安装目录 `package.json` 版本一致（`node_modules/@mengls1620/dsh-deepseek-status/package.json`）。
- **改了设置不生效**：确认真实保存位置（profile `cordis.patch.yml` 中该行的 `config`），并观察 `fetchedAt` 的推进间隔。

## 4. 回滚

```sh
dsh plugin --profile <profile> remove @mengls1620/dsh-deepseek-status
dsh plugin --profile <profile> add @mengls1620/dsh-deepseek-status@0.1.8
```

或从备份恢复 profile 的 `package.json`、`cordis.patch.yml` 与插件目录，再完全重启。

## 5. 禁止项

- 不要同时安装旧包 `dsh-deepseek-status` 与新包 `@mengls1620/dsh-deepseek-status`；
- 不要在未告知用户、未得到确认时重启客户端；
- 不要为了排障删除用户的 profile、数据目录或聊天记录；
- 不要建议用户关闭安全设置、权限或沙箱来「解决」安装问题；
- 不要手动改 `node_modules` 里的插件文件（除明确排障且已备份），正式修复应走发布新版本。
