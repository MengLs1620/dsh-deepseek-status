# 更新日志（Changelog）

## 0.1.9

- 面板上的「打开状态页」链接现在跟随配置的 `statusUrl`，不再写死默认地址：宿主路由返回校验后的 URL，浏览器只渲染 `http(s)` 链接。
- 刷新串行化：同一时刻只抓取一次，抓取期间的触发合并为一次后续刷新，过期结果不再覆盖新数据。
- `configForms` 从必装注入服务改为可选：浏览器半区只注入 `slots` 和 `locale`，没有该服务时跳过设置卡，会话头部挂件照常工作。这也修复了在没有该服务的部署上整个浏览器半区一直 pending 的问题。
- 易变配置按解析后的值比较：状态页地址或超时变化立即刷新，轮询间隔变化重新挂定时器，其它插件的更新不触发动作。
- 抓取加固：`statusUrl` 必须是绝对 `http(s)` URL；解压后响应体超过 2 MiB 视为抓取失败（保留最后一次成功快照）。正常页面约 216 KiB。
- 发布闸门：CI 安装测试依赖、校验其可解析、运行 `npm run check`（语法 + 全部测试），并以 `--ignore-scripts` 发布。devDependency 精确钉 `@deepseek-ai/schemastery` 3.19.0，不提交 lockfile。
- 描述：`in the sidebar` 改为 `in the Web UI session header`，对齐上游文档修复 KekuKase/dsh-deepseek-status#3。
- 测试从 17 条增至 26 条：面板链接 URL、刷新串行化、超大响应、设置服务可选（包括未注入时通过 `ctx.reflect` 读取）、配置变化处理。
- 测试在 Windows + DSH 0.2.2-rc.3 运行时通过（`@deepseek-ai/schemastery` 3.19.0、cordis 4.1.0）：`npm test` 26/26 通过。UI 验收也是在 0.1.9 + 该环境完成：挂件、面板、设置卡片，以及一次真实的配置保存（轮询间隔 120000 → 20000 → 120000）均已验证。
- 文档：README 面向最终用户重写（截图、安装/升级、配置、隐私、自检）；开发者说明拆分到 DEVELOPMENT.md；新增面向 AI 助手的 AGENTS.md 安装/验证/回滚 SOP。

## 0.1.8

- 增加包图标：`package.json` 现在声明 `"icon": "assets/icon-512.png"`，该文件也包含在发布包中，因此 DSH 的已安装插件列表会显示插件自己的图标，而不是通用占位图。
- 文档：发布更正后的维护说明（代码自 0.1.4 起由 MengLs1620 维护；自 0.1.6 起独立发布 npm）。0.1.7 的 npm 页面带的是旧措辞；本次发布把更正带到 npm。
- 无行为或配置变化；代码与 0.1.7 相同。

## 0.1.7

- 维护版本，用于验证 npm trusted publishing 发布链路。代码、行为与配置与 0.1.6 相同，仅版本号变化。发布改由 GitHub Actions 在 Release 时通过 npm trusted publishing（OIDC）完成，不再使用长期 token。

## 0.1.6

- 维护 fork：本版本由 MengLs1620 以 `@mengls1620/dsh-deepseek-status` 发布；代码自 0.1.4 起由 MengLs1620 维护，自 0.1.6 起独立发布。包名、浏览器模块 id、宿主 bundle 名、设置卡 key 与行名全部跟随新包名；行为其它方面不变。上游 npm 包 `dsh-deepseek-status`（0.1.3）已停止维护，且在 DSH 0.2.x 上失败，迁移用户需先卸载它。
- 发布配置：`publishConfig.access = public`；repository、homepage 与 bugs 指向 fork；README 记录 scoped 安装、迁移步骤与维护说明。
- 在 DSH 0.2.2 上把状态面板改为不透明。2026-11-04 的桌面主题把 `--dsw-specific-menu` 作为 64% 不透明的菜单填充色（深色 `#303136a3`、浅色 `#fcfdfeb3`），设计上是叠在官方菜单背景模糊之下使用；面板把这个 token 当作唯一背景且没有模糊，导致后面的页面透出来、与面板文字混在一起。现在面板把同一 token 作为渐变叠在不透明的 `--dsw-alias-bg-layer-2` 之上：保留主题色调，结果不透明，其它不变。
- 无行为或配置变化。在 Windows + DSH 0.2.2-rc.1（桌面端、深色主题）验证：重启后面板不透明、头部挂件仍渲染、`GET /deepseek-status/current` 返回 200、轮询保持配置间隔、`npm test` 17/17 通过。

## 0.1.5

- 恢复插件在 UI 中的设置，采用两段式修复。0.1.4 移除了 DSH 0.2 删除的设置接缝，但配置因此失去了回到界面的途径。
- 宿主半区：三个 `Config` 字段现在声明为 `.volatile()`——这是 Host 设置服务把条目投影成表单的条件（「Forms expose only volatile fields from active, uniquely addressed profile entries」），也是让解析后的值保持活引用的关键。易变字段解析成一个通过 `get()` 读取的稳定引用，因此 `readField()` 会解包它，`resolveSettings()` 每次使用时执行，而不是在激活时只执行一次。订阅 `loader/volatile-update` 会重新挂载轮询器，这就是保存的编辑无需重启即可生效的原因（替代旧的 `settingsHooks.onChange() { arm(); }`）。普通的非易变配置值仍然有效。
- 浏览器半区：提供插件页渲染的设置卡。没有客户端会按 schema 自动建表单——`autoGenerate` 只是随数据传递、从不被读取，每个官方设置页都自带配套卡片——所以这一半按插件页查找的精确 key 注册一张卡（`plugins.bundle.config` 用包名，`plugins.row.config` 用 `` `${package}#${rowId}` ``），底层是用 `deepseek-status` 命名空间上的 `SettingsFormModel`，每个字段分别对应状态页 URL、轮询间隔与抓取超时。注册被 `ctx.configForms.whileServed([...])` 门控，并按 slot 各自捕获异常：设置卡绝不能把状态挂件一起拖垮。
- 测试：8 → 17 条。宿主侧：通过 `get()` 读取易变引用、在 `loader/volatile-update` 时重新挂载，以及——在真实 `@deepseek-ai/schemastery` 之上——每个字段保持易变、`simplify()` 会为持久化解包引用。浏览器侧：卡片按字面 key 注册、携带完整表单外壳（缺少 `available` 会让所有字段藏在「不可配置」提示后面）、渲染三个字段、命名空间停止服务时显示不可用提示而非空字段、缺少 primitives 模块或设置服务时报告而不是抛错、只使用中英字典中都存在的标签。schema 守卫在 peer 依赖缺失时会跳过自身，因此一个裸 checkout 仍能运行其余测试套件。
- README：设置页被记录为第三种覆盖路径，包含精确 slot key 与无需重启的行为。

## 0.1.4

- 修复宿主半区在 DSH 0.2 上无法注册设置的问题。DSH 0.2 不再提供本插件使用的设置接缝辅助函数（`installSettingsSection`、`settings.installSection`）以及 `settings/updated` 事件，因此注册静默失效、插件配置从不出现。宿主半区不再导入 `@deepseek-ai/dsh-settings`，也不再注入设置服务。
- 配置现在只来自 bundle 行的 `config`（`cordis.patch.yml`），按导出的 `Config` schema 校验，行内无 config 时应用文档中的默认值。修改配置在重启后生效，这符合当前 Host 插件契约（配置在激活时解析一次）。
- 从 `peerDependencies` 移除 `@deepseek-ai/dsh-settings`：不再有任何代码导入它。
- 重做宿主测试：现在固定缺失配置回退、单轮询器生命周期，以及不依赖任何设置服务。测试 harness 里的守卫会让旧代码测试失败，防止回归再次悄悄出现。

## 0.1.3

- 在 DSH 0.1.2 中支持 settings provider API，同时保留旧版设置辅助函数。
- 设置变化或插件卸载时正确释放 Cordis 定时器。
- 上游刷新失败时保留最后一次成功快照，并在面板中报告失败。
- 处理不可用的 uptime 值，避免面板崩溃。
- 为两种设置 API 形态、延迟可用的设置、轮询清理、过期快照与会话头部挂件增加回归测试。

0.1.2 仅在本地用于测试最初的设置兼容性修复。
