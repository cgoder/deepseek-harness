# dsh 更新检测可行性

- resolved: 2026-08-17 research subagent
- type: `wayfinder:research`
- mode: AFK
- status: resolved
- blocks: 更新提示的呈现位置与交互
- blocked-by: —

## Question

`npm view @deepseek-ai/dsh version` 做后台更新检测的可靠性面：npmmirror 等镜像的版本缓存延迟（发布后多久可见）；离线/断网时的失败行为与超时；返回值解析（dist-tags vs versions）；Rust 侧调用的封装（走 `find_bin("npm")` + `launcher`？）；本地是否已有更轻的检测面（registry API 直查？）；semver 比较是否引入 crate。

## 上下文

- 已定偏好：每次启动后台静默查，不阻塞主流程，结果只在界面提示
- 用户环境可能用 npmmirror（本机 ~/.npmrc 即 npmmirror）
- 现状：`upgrade_dsh` 用 `npm install --prefix … @deepseek-ai/dsh@latest`；版本读取有 `run_dsh_version()`

## 解决方式

`/research` subagent 调查（npm registry 行为 + 本地实验 `npm view` 对 npmmirror 的延迟/离线行为），结论记回本票据。

## 结论

### 实验环境与版本事实
- 本机：fnm node v24.16.0 + npm 11.13.0（票据里写的 11.6.2 与实测不符）；`~/.npmrc` 指向 `https://registry.npmmirror.com`，无 scope 级 registry 覆盖。
- **当前最新版是 0.1.0-rc.7（不是 rc.6）**：npmjs 与 npmmirror 的 dist-tags 均为 `{"latest":"0.1.0-rc.7","next":"0.1.0-rc.7"}`；rc.7 发布于 2026-08-17T11:50:59Z（npmjs packument `time` 字段）。本机全局 @deepseek-ai 目录为空（dsh 未装，无法用 `dsh --version` 交叉验证）。
- 版本历史：`0.0.1-rc.1/2/5`、`0.1.0-rc.2/3/6/7` —— 全部是 `x.y.z-rc.n` 形态，无正式版。

### npm view 行为（npm 11 官方文档 + 实测）
- 文档（docs.npmjs.com/cli/v11/commands/npm-view）：`npm view <pkg> [field[.subfield]...]`，默认取 `latest` tag；单字符串单版本输出不引号不染色（可直接管道）；`--json` 输出 JSON。
- 实测：`npm view @deepseek-ai/dsh version` → 裸输出 `0.1.0-rc.7`（exit 0）；`--json` → `"0.1.0-rc.7"`；`dist-tags.latest --json` → 同。
- **npm view 总是抓全量 packument**（`GET /@deepseek-ai%2fdsh`，npmmirror 约 40KB / npmjs corgi 约 27KB），即使只取一个字段；带 cache revalidation（`cache revalidated`）。
- 离线+缓存命中：0.17s 返回缓存值；离线+无缓存：`ENOTCACHED`，exit 1，0.17s 快速失败。

### 失败形态与耗时（离线/断网）
- ECONNREFUSED（连不上）：exit 1，~0.15s；ENOTFOUND（DNS 失败）：exit 1，~0.22s；E404：exit 1。均为快速失败。
- **危险场景——丢包黑洞**：`--registry http://192.0.2.1:8080/ --fetch-timeout 3000 --fetch-retries 0` 实测挂起 **75.2s**（= macOS TCP connect 超时）才失败。**npm 的 fetch-timeout 不覆盖 TCP connect 阶段**，默认 fetch-retries=2、fetch-timeout=300000ms、退避 10-60s，最坏可拖数分钟。→ Rust 侧必须自带墙钟超时并 kill 进程组（`run_npm` 已有此模式），不能依赖 npm 自身的超时。

### 延迟对比（本机实测，各 3 次）
| 检测面 | 耗时 | 体积 | 备注 |
|---|---|---|---|
| `npm view … version`（npmmirror） | 0.25–0.34s | 拉全量 packument ~40KB | 含 ~0.15s node/npm 启动 |
| curl npmmirror `/latest` | 0.06–0.14s | 5.2KB | CDN 缓存 300s（max-age=300，x-cache HIT） |
| curl npmmirror `/-/package/…/dist-tags` | 0.11–0.13s | **43B** | CDN 缓存 300s |
| curl npmjs `/latest` | 0.73–0.93s | 5120B | 无缓存头（cf-cache-status: DYNAMIC），每请求回源 |
| curl npmjs `/-/package/…/dist-tags` | 0.70–1.87s | 43B | 同上；方差大 |
- npmjs 直连在本机可达但慢且方差大；大陆真实场景更差（GFW 丢包=上述 75s 挂起场景）。npmmirror 快 5–10 倍。
- 注意：npmjs 的 `/pkg/dist-tags` 返回 404，正确端点是 `/-/package/<pkg>/dist-tags`（npmjs 与 npmmirror 均支持）。

### npmmirror 同步延迟
- npmmirror 是 npmjs 的只读镜像：自动同步（历史文档为 ~10 分钟轮询；社区实测体感 5–60 分钟不等，取决于包热度/负载），另有懒同步（请求缺失版本时回源拉取）。
- 手动触发：`cnpm sync <pkg>` 或 `PUT https://registry.npmmirror.com/-/package/<pkg>/syncs`（cnpmcore docs/internal-api.md；现需 token）。发布 CI 可加此步把延迟压到秒级。
- 实测证据：rc.7 发布 08-17T11:50Z，npmmirror 的 dist-tags 已是 rc.7（但镜像不刷新 `time.modified` 字段，仍停在 08-13——不能拿该字段判断镜像新鲜度）。
- **对提示时效的影响**：走 npmmirror 的新版本提示通常比发布晚几分钟到 ~1 小时；对"非阻塞、仅提示"完全可接受；若要求准实时，发布流水线手动触发同步即可。

### Rust 侧建议
- **检测面：推荐 `find_bin("npm")` + `launcher()` + `npm view @deepseek-ai/dsh version --json`**。理由：PowerD 本来就依赖 node/npm（dsh 安装、`run_npm` 已有超时+kill 进程组+stdout 透传模式，可直接复用）；零新增依赖（Cargo.toml 现只有 tauri/serde/libc）；自动跟随用户 ~/.npmrc 镜像（大陆用户自动走 npmmirror，比硬编码 npmjs 快 5-10 倍且避开 GFW）；`--json` 输出 `"0.1.0-rc.7"` 用 serde_json（或直接 trim 引号）即可解析。
- **超时与失败降级**：后台线程/异步跑，绝不阻塞主流程；墙钟超时 3–5s → kill 进程组（`process_group(0)`，unix）→ 静默当"无新版本"处理，仅 log；任何非零退出/非 JSON 输出/解析失败都走同一静默路径。可再存 last-check 时间+last-known 版本（app 配置目录），每天最多提示一次同一版本、避免每次启动都打网络。
- **registry API 直查（curl 式）**：`/-/package/<pkg>/dist-tags` 仅 43B、0.1s，是最轻面；但 Rust 侧需新增 HTTP 客户端（reqwest/ureq）+ TLS 依赖，且要自己解析用户镜像配置（npmrc 解析有 scope 覆盖等坑）。**不建议现在做**；如将来要，优先 npmmirror+`/-/package/.../dist-tags`（npmjs 无缓存头、每请求回源、大陆更慢）。
- **semver 比较**：版本形态固定 `x.y.z[-rc.n]`。推荐引入 `semver` crate——零依赖、纯 std、体积极小，正确处理 prerelease 序（0.1.0-rc.7 < 0.1.0，且 0.1.0-rc.7 > 0.1.0-rc.6），手写 ~30 行易错（v 前缀、缺位、rc 序）。若坚持零新增 crate，手写只支持 `x.y.z` 或 `x.y.z-rc.n` 的比较器也可行，但收益小。

### 结论
1. 检测面：`npm view @deepseek-ai/dsh version --json`（走 find_bin+launcher），自动跟随用户镜像；registry API 直查留作未来优化。
2. 超时 3–5s 墙钟（kill 进程组）+ 一切失败静默降级为"无提示"；后台执行不阻塞启动。
3. 版本比较用 `semver` crate（零依赖）；提示"有新版本"前先与本地已装版本比较，同一版本只提示一次。
4. npmmirror 延迟（分钟级~1 小时）对提示时效可接受；发布 CI 可加 `cnpm sync`/syncs API 压到秒级。
5. 当前最新 0.1.0-rc.7（票据假设的 rc.6 已过时）。
