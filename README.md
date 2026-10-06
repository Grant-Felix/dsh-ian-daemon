# dsh-ian-daemon — DeepSeek Harness 的开机自启与看护插件

一个 Harness 插件（Host 半边 + Client 半边），用 systemd 用户服务实现三件事：

| 需求 | 实现 |
| --- | --- |
| 1. systemd 开机自启动 | `dsh-ian-daemon.service`（用户级 unit，无需 root）+ `loginctl enable-linger` 使其在开机（而非登录）时启动 |
| 2. 崩溃 / 损坏自恢复，多次失败进安全模式并汇报 | 看护脚本 `supervisor.sh`：启动前校验配置（损坏则从最近一次正常快照恢复）→ 运行 `dsh` → 统计滚动窗口内的快速失败次数 → 达阈值切换干净的安全 profile `dsh-safe`，写事故报告并弹桌面通知；systemd 的 `OnFailure=` 作为第二道防线 |
| 3. 手动“重启”按钮 | Client 半边在输入框下方的 composer dock 中渲染 **重启** 按钮（点两次确认），调用 Host 的 HTTP 接口完成重启 |

## 项目改名

本项目原名为 `dsh-autostart`，现定名为 **dsh-ian-daemon**。除名称外行为不变，但**已安装的机器会自动迁移**：

| 项目 | 旧 | 新 |
| --- | --- | --- |
| 包名 / 插件行 | `@local/dsh-autostart` / `dsh-autostart` | `@local/dsh-ian-daemon` / `dsh-ian-daemon` |
| 主 / 安全模式 / 自测单元 | `dsh-harness.service` 等 | `dsh-ian-daemon.service` / `-safemode` / `-selftest` |
| 数据目录 | `~/.dsh/autostart` | `~/.dsh/ian-daemon` |
| 接口前缀 / 请求头 | `/dsh-autostart` / `x-dsh-autostart` | `/dsh-ian-daemon` / `x-dsh-ian-daemon` |
| 环境变量前缀（测试钩子） | `DSH_AUTOSTART_*` | `DSH_IAN_DAEMON_*` |

迁移在插件激活时自动完成：先搬数据目录，再写新单元、`daemon-reload`、**停用并删除旧单元**、启用新单元，
保证任何时刻只有一个单元处于 enabled（`node tests/migration.mjs` 覆盖了这条路径）。
只会动带本项目标记的单元；不认识的文件一律不碰。

## 使用

安装后插件会自动完成安装与启用（`installOnActivate`、`startAtBoot` 默认 `true`）。
它**不会**立刻启动服务——当前手动运行的实例仍占着端口；下次开机（或点“重启”）时由 systemd 接管。

> 交接注意：**不要**在手动实例还占着端口时直接 `systemctl --user start dsh-ian-daemon.service`，
> 那会连续启动失败并升级为安全模式（安全模式是粘性的）。正确做法是点一次「重启」——
> 助手会等旧进程退出后再 `systemctl --user restart`，不会抢端口；或者先退出手动实例再 start。

- **重启按钮**：同时出现在两个位置，任一位置不可见都不影响另一个：
  - **侧边栏底部、设置（Settings）上方那一行**：↻ 图标 + `重启`（侧栏收起时只显示 36×36 图标按钮，悬停有提示）；
  - **输入框下方那一排状态条**中：一个小胶囊按钮 `重启`。
  第一次点击变为 `确认重启？`（6 秒内），第二次点击执行；重启中显示 `重启中…`，新进程起来后页面自动刷新。
  上次启动进入过安全模式时，按钮带橙色边框与提示点。
  按钮整体包在 `SafeBoundary` 里：即使花哨版本渲染崩溃，也会退化成不带样式的普通 `重启` 按钮，不会出现空白格。
  - 若当前进程由 systemd 托管 → `systemctl --user restart dsh-ian-daemon.service`；
  - 若当前是手动运行 → 派发一个脱离终端的助手脚本，等旧进程退出后接管（已启用自启动则交给 systemd，否则原样重新拉起命令行）。

  页面在没有手动刷新的情况下通常会通过客户端 HMR 拿到新代码；若插件刚安装完仍看不到，`Ctrl+Shift+R` 硬刷新一次即可。

  重启流程本身跑在**模块级**而不是组件里：服务端一断，会话级 slot 会塌、组件会 unmount，
  组件清理绝不能把已经在飞的重启流程掐死。流程规则是「证明页面已经过期才刷新」——
  POST 抛错（服务端先死、响应丢失）不再放弃；服务端 pid 变了、或观测到「断开又回来」就刷新页面；
  一直没起来则给出提示让你手动刷新。每一步都会回执到 `/dsh-ian-daemon/event`。
- **状态与日志接口**（仅本机可访问，写操作需带 `x-dsh-ian-daemon: 1` 头）：

  ```
  GET  /dsh-ian-daemon/status       # systemd / 看护 / 事故 / 路径 全量状态
  GET  /dsh-ian-daemon/log?lines=200&source=dsh
  POST /dsh-ian-daemon/restart      # 同“重启”按钮
  POST /dsh-ian-daemon/install      # 重写脚本与 unit、daemon-reload、enable
  POST /dsh-ian-daemon/uninstall    # 反注册并删除 unit（报告保留）
  POST /dsh-ian-daemon/repair       # 立刻做一次配置校验/恢复
  POST /dsh-ian-daemon/reset?restart=1   # 清除安全模式（并可立即重启）
  POST /dsh-ian-daemon/selftest     # 验证本会话能启停 systemd 用户 unit
  POST /dsh-ian-daemon/event        # 页面回执（重启生命周期/UI 崩溃），写入 state/client-events.jsonl
  ```

  `/status` 里的 `health` 是自检结论：解析**生成的**脚本，报告其中烘焙的 node/dsh 路径是否仍然存在
  （`health.ok=false` 说明自启动"看起来装好了"但实际起不来）；`lastInstall` 是最近一次安装结果。

## 生成的文件

```
~/.config/systemd/user/dsh-ian-daemon.service            # 开机自启 + 看护（enabled）
~/.config/systemd/user/dsh-ian-daemon-safemode.service   # OnFailure= 兜底，不随开机启用
~/.config/systemd/user/default.target.wants/dsh-ian-daemon.service -> ../dsh-ian-daemon.service
~/.dsh/ian-daemon/bin/supervisor.sh                    # 看护脚本（由插件生成，勿手改）
~/.dsh/ian-daemon/bin/relaunch.sh                      # 手动实例的接管助手
~/.dsh/ian-daemon/state/                               # mode / failures / last_exit / incident.json
~/.dsh/ian-daemon/backup/                              # 最近一次能正常组合的 profile 配置快照
~/.dsh/ian-daemon/reports/                             # 事故报告（incident-*.md、latest.md、broken-*/）
~/.dsh/ian-daemon/logs/                                # supervisor.log 与 dsh.out.log
```

开机后 GUI 地址（带 token）写在启动日志里：

```bash
systemctl --user status dsh-ian-daemon.service
grep -o 'http://127.0.0.1:[0-9]*/?token=[^ ]*' ~/.dsh/ian-daemon/logs/dsh.out.log | tail -1
```

## 恢复阶梯

1. **启动前校验**：`dsh --profile web --dump-config`。失败 → 把坏配置留档到 `reports/broken-*`，用 `backup/` 里的快照恢复并继续启动；恢复后仍不行 → 直接进安全模式。
2. **快速失败计数**：每次运行存活不足 `healthySeconds`(120s) 记 1 次失败；滚动窗口 `failureWindowSeconds`(600s) 内累计到 `failureThreshold`(3) → 进入安全模式。
3. **安全模式**：首次使用时用官方模板创建 `dsh-safe` profile（只含随 dsh 发布的 bundle），随后一直用它启动；**安全模式是粘性的**，需要显式复位：

   ```bash
   curl -X POST -H 'x-dsh-ian-daemon: 1' 'http://127.0.0.1:3080/dsh-ian-daemon/reset?restart=1'
   # 或：rm -f ~/.dsh/ian-daemon/state/{mode,failures} && systemctl --user restart dsh-ian-daemon.service
   ```
4. **汇报**：写 `reports/incident-<时间>.md` + `state/incident.json`，并发 `notify-send` 桌面通知（`notify` 可关）；`/dsh-ian-daemon/status` 会把事故回传给按钮。
5. **systemd 第二道防线**：若看护脚本自身反复死掉（`StartLimitBurst=5/90s`），主 unit 进入 failed 并触发 `dsh-ian-daemon-safemode.service`，它用 `--force-safe` 启动安全模式并同样写报告。

## 配置（profile 的 `cordis.patch.yml` 该行 `config`）

`unitName`、`safeUnitName`、`safeProfile`、`safeTemplate`、`failureThreshold`、`failureWindowSeconds`、
`healthySeconds`、`maxBackoffSeconds`、`port`、`host`、`extraAppArgs`、`cliPath`、`nodeBin`、
`homeDir`、`unitDir`、`installOnActivate`、`startAtBoot`、`enableLinger`、`notify`。

插件没有声明 Config schema（因此插件管理页不显示配置表单），改动请直接编辑补丁行；每次插件激活都会按当前配置重写脚本与 unit。

## 卸载

```bash
curl -X POST -H 'x-dsh-ian-daemon: 1' http://127.0.0.1:3080/dsh-ian-daemon/uninstall
rm -rf ~/.dsh/ian-daemon              # 需要时连报告一起删
loginctl disable-linger "$USER"      # 若不再需要免登录启动
```

## 测试

```bash
bash tests/ladder.sh
```

用桩命令在 `.selftest/` 里跑完整阶梯（10 项断言组）：崩溃升级到安全模式、健康运行清零、
干净退出改为重启而不是停服、坏配置隔离+恢复、接管助手两条分支、
**瞬时 0 退出算启动失败而不是正常退出**、**命令行为空时报错而不启动**、
**从已安装布局自动修复 node/dsh 路径**、**收到 stop 信号立刻退出**。
不触碰真实 profile 与真实 unit。

## 修复记录

**2026-10-05 — "点重启后关掉但没起来"**。根因有两层：

1. 生成的 `supervisor.sh` 里 `DSH_CLI` 为空（是上一轮为了热重载而做的插件开关操作，让仍在运行的**旧模块**重新激活并覆盖了正确脚本）。空路径下执行的是 `node "" web …`，Node 把它当成"没有脚本"进入 REPL，stdin 是 `/dev/null` 立刻 EOF，于是**以 0 退出**；
2. 看护脚本把这次瞬时 0 退出当成"正常退出"，于是自己收工，systemd 的 `Restart=on-failure` 也不会重启 → 服务停在那里。

现在三层都堵上了：生成端拒写坏命令行（`cliPath`/`nodeBin` 解析不到就报错不写）、
看护端启动前自检并按已安装布局自动修复 node/dsh 路径（修不了就写报告重试，绝不当作正常退出）、
退出语义改为"只有当子进程存活够久才算健康；瞬时 0 退出按失败计数并升级安全模式；
干净退出也照样重启，只有 `systemctl stop` 才结束服务"。

**2026-10-06 — "systemd 托管时点重启，服务回来了但页面不回来"**。服务端侧证据表明重启是成功的
（新实例起来并打印了 URL、一直存活；`~/.dsh/logs` 里那份 `EADDRINUSE` 启动失败日志是**另一个** dsh 进程，
看护脚本并未参与）。问题在页面侧：客户端重启流程有两个缺陷 —— ① `POST /restart` 一旦抛错就整体放弃
（而服务端先死、响应丢失恰恰是常态），既不再轮询也永不刷新；② 流程挂在 dock 里的组件上，
服务端一断会话级 slot 塌掉、组件 unmount，`cleanup` 就把流程掐死了。现在整个生命周期移到模块级
（与 React 挂载无关），POST 失败继续观察，并用 `tests/restart-flow.mjs` 的 17 条断言锁住这条回归。

## 已验证 / 未验证

已在本机（Bazzite 44 / systemd 259 / DSH 0.2.0-rc.2）实测通过：

- 插件行激活、Client slot 注册（`conversation.composer.dock` 与 `sidebar.footer.action` 中 `dsh-ian-daemon`，active）；
- HTTP 接口：`/status`、`/repair`、`/selftest`（真实启停 systemd 用户 unit）、`/mounted`，写操作鉴权（无头 403、GET 405）；
- unit 语法 `systemd-analyze --user verify`、`systemctl --user is-enabled` = `enabled`、`loginctl` linger；
- 看护阶梯 **11 组断言全绿**（`bash tests/ladder.sh`）+ 改名迁移测试；
- 用与 `ExecStart` 完全相同的命令行真实启动过 Harness；
- **真实重启电脑后自动起来**（开机 15 秒内拉起，无需登录），关机时看护脚本干净退出；
- 手动「重启」按钮点击后成功由 systemd 接管。

未验证：不同发行版/桌面环境下的表现；非 fnm 安装 node 的路径布局。

## 安装（从 GitHub）

```bash
dsh plugin --profile web add github:Grant-Felix/dsh-ian-daemon
```

或在 Harness 的插件管理页里用同一 spec 安装。装好后插件会自动写 unit、enable 并开启 linger；
当前手动运行的实例要等下次开机或点一次「重启」才由 systemd 接管。

## License

MIT © 2026 Grant-Felix — 见 [LICENSE](LICENSE)。

## 已知边界

- 服务绑定默认回环地址；`dsh web` 的 GUI 需要带 token 的 URL，见上文日志取法。
- 服务在开机时若端口被别的实例占用，会按快速失败计数升级——这是设计行为。
- 只接管自己写过的 unit：若 `~/.config/systemd/user/dsh-ian-daemon.service` 已存在且不含本插件标记，会先备份为 `*.pre-dsh-ian-daemon` 再覆盖。
- `package.json` 里的 `private: true` 只用于避免误发到 npm registry；从 GitHub 安装不受影响，要发布到 npm 时删掉它即可。
