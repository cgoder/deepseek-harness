# npm 安装进度可读性

- resolved: 2026-08-17 research subagent
- type: `wayfinder:research`
- mode: AFK
- status: resolved
- blocks: 启动状态机与切换时序、异常矩阵与修复指引
- blocked-by: —

## Question

`npm install` 的输出里能可靠拿到什么进度信息？`--json` / `--loglevel` 选项能否提供结构化阶段（fetch / extract / reify）？安装失败时 stderr 能解析出什么诊断（错误码、网络 vs 权限 vs 磁盘）？`npm ci` 与 `npm install` 对本场景（固定包名 @deepseek-ai/dsh 全新安装）的取舍？本地实验即可（本机有 npm 11.6.2）。

## 上下文

- PowerD 用 `npm install --prefix <dir> --no-audit --no-fund @deepseek-ai/dsh`（`run_npm`，stdout/stderr 已转发为 `server:stdout` / `server:stderr` 事件）
- 已定偏好：阶段式进度（非百分比），但"安装中"能否细分（如 下载中 → 解压中 → 写入中）取决于此票据结论

## 解决方式

`/research` subagent 调查（npm 文档 + 本地实验 `npm install --json` 等），结论记回本票据。

## 结论

环境：npm 11.6.2（fnm alias）/ Node v24.16.0，registry 为 npmmirror 镜像。实验全部在 /tmp 与 /private/tmp 下临时目录完成（`is-number@4.0.0` 等极小包 + 本地构造的带 postinstall 的包），已清理；未改动 ~/.npmrc 与任何全局配置。文档依据：docs.npmjs.com 的 npm-install、Logging、Config（v11 页）。

### 1. `--json` 的结构化输出（实测）

- **只有最终结果，没有流式过程**：`npm install --json` 全程 stdout 无输出，命令结束后一次性打印一个 JSON 对象；成功形态：`{"add":[{"name","version","path"}],"added":N,"changed":0,"removed":0,"audited":0,"funding":0,...}`（`--no-audit/--no-fund` 时 audited/funding 为 0）。
- **失败形态**（exit≠0）：stdout 打印 `{"error":{"code","summary","detail"}}`；同时 stderr 有 `npm error code X` 开头的人类可读块 + debug log 路径。
- `--json` 与 `--loglevel=info` 可叠加：stdout 仍是纯 JSON（实测可被 json.load 直接解析），日志全部走 stderr。
- 默认 notice 级下 stdout 只有一行摘要 `added N packages in Xms`；**npm install 本身没有任何进度条/百分比**。

### 2. 流式阶段信息只存在于 stderr 日志

- `--loglevel=info`：stderr 逐行实时输出 `npm http fetch GET 200 <url> Xms (cache miss)`——先各包 metadata，再各包 `.tgz` tarball，可据此划出「下载元数据 → 下载 tarball → （末条 fetch 后）解压/写入」两到三段，行数可作「已下载 k 个包」的近似计数（包总数未知，只能数行）。这是**最稳定可靠**的流式分界。
- `--loglevel=silly`：额外出现 arborist 内部标记（`idealTree buildDeps` / `fetch manifest` / `placeDep` / `reify moves {}` / `ADD node_modules/<pkg>`），可细分 resolve→download→extract/write，但属未文档化内部日志，npm 升级可能变化且极啰嗦，不建议作为 UI 主依赖。
- `--timing`：stderr 打印 `npm timing idealTree Completed in Xms`、`npm timing reify:unpack Completed in Xms` 等（阶段：npm:load → command:install → idealTree→ reify 及 reifyNode:unpack/build），并把 timers 写入 timing JSON 文件（`--logs-dir` 可重定向）；但默认关闭，仅诊断用。
- `--foreground-scripts`（默认 false）：把依赖的 preinstall/install/postinstall 脚本输出转发到 npm stdout（v7+ 默认隐藏，实测默认无输出、开启后脚本行出现在 stdout）；dsh 无 install 脚本时无影响。
- 噪音：stderr 会混入 `npm notice New major version of npm available` 更新检查，可用 `--no-update-notifier` 关闭。

### 3. 失败诊断（实测注入）

- 退出码：ETARGET/E404/网络类 → **exit 1**；文件系统类 → npm 直接把数值 errno 当退出码（npm 源码 lib/utils/error-message.js `getExitCodeFromError`），shell 显示 256+errno：EACCES(-13)→**243**、EPERM(-1)→255、ENOENT(-2)→254、ENOSPC(-28)→228。**注意 EACCES 不是 exit 1。**
- JSON error.code 实测：版本不存在→`ETARGET`（summary: "No matching version found for is-number@99.99.99."）；包不存在→`E404`；目录无写权限→`EACCES`（errno -13, syscall mkdir）；registry 连接拒绝→`ECONNREFUSED`；DNS 失败→`ENOTFOUND`（summary: "getaddrinfo ENOTFOUND ..."）。ENOSPC 未注入（macOS 无法安全造磁盘满），但源码 errno→退出码映射可推出 code=ENOSPC、exit=228。
- stderr 人类可读块首行固定为 `npm error code <CODE>`，可正则提取；`--json` 的 error.code/summary/detail 更干净（detail 还带「网络问题/代理」或「权限问题」等提示文案）。
- **重大陷阱（实测）**：网络类失败（ENOTFOUND）时 npm 默认**静默重试**——默认 fetch-retries=2、mintimeout=10s、factor=10、maxtimeout=60s（`npm config get` 实测），ENOTFOUND 场景实测挂起 >60s 且 stdout/stderr 零输出；加 `--fetch-retries=0` 后实测 0s 立即失败（exit 1 + JSON error）。PowerD 必须加 `--fetch-retries=0`（或自带超时）。ETARGET/E404 是 HTTP 404 响应、不重试，快速失败。

### 4. `npm ci` vs `npm install`

- `npm ci` 要求已存在且与 package.json 同步的 package-lock.json，否则 EUSAGE 失败（实测无 lockfile / lock 不同步两种形态）；且会先清空 node_modules 再严格按 lockfile 装。
- 本场景（固定包名 @deepseek-ai/dsh、版本浮动、全新安装）：**`npm install` 更合适**，无需维护 lockfile；若要确定性版本，应改为精确锁版本号 + 提交 lockfile 后配 npm ci。
- 注意：`npm install <pkg>` 默认会把依赖写入 `<prefix>/package.json` 并生成 package-lock.json（实测）；不想污染目标目录可加 `--no-save --no-package-lock`（实测只生成 node_modules，`--json` 输出不受影响）。
- 实验环境坑（与本场景无关）：/tmp 是符号链接时 lockfile 内路径会写成相对绝对路径混合形态（/tmp vs /private/tmp 真实路径不一致），导致 npm ci 校验失败；真实目录无此问题。

### 5. 给 PowerD 的建议

- **阶段式进度可靠粒度 = 两段**：下载中（stderr 出现首个 `npm http fetch ... tgz` 到最后一个 fetch 行）→ 安装中（末条 fetch 后到 `added N packages in Xms` / `npm info ok`）→ 完成（JSON 到达或进程退出 0）。三段（resolve/下载/解压写入）只能靠 silly 级内部日志或 --timing，不稳定，不建议做进 UI。
- **失败诊断信号**：优先解析 `--json` 的 stdout（error.code/summary/detail）；备选 stderr 首行 `npm error code (\w+)` + 退出码。分类映射：ETARGET/E404→包或版本不存在；ENOTFOUND/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN→网络；EACCES/EPERM→目标目录权限；ENOSPC→磁盘；退出码 243/255/254/228 对应 EACCES/EPERM/ENOENT/ENOSPC。
- **推荐命令行**：`npm install --prefix <dir> --no-audit --no-fund --no-update-notifier --fetch-retries=0 --no-save --no-package-lock [--loglevel=info]`；前端把 stdout 当「结果通道」（info 级下仅摘要行；加 `--json` 则成功/失败均为单条 JSON），把 stderr 当「进度+错误通道」（fetch 行→进度，`npm error` 块→失败原因）。
- `--json` 成功时 add[].version 可直接确认安装的 dsh 版本。
