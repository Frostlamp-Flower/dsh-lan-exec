# dsh-lan-exec（局域网远程执行）

把两台装了 DeepSeek Harness 的电脑配成一对：一台跑会话，另一台**远程执行**被转发过去的工具调用。

名字里的 `exec` 就是这个意思——不是一条被动的"桥"，而是本地模型**操控**另一台 DSH 去执行：转发工具调用、在那边跑代码、共享数据空间。`lan` 保留，因为这套东西只在局域网内配对使用。

两个角色按"干什么"命名，不再用 client/server，避免和网络层的主从关系混淆：

| 名称 | 是哪台 | 干什么 |
|---|---|---|
| **origin**（发起端） | 跑会话、跑模型的那台 | 模型在这里写 TS，`tools.xxx(...)` 被转发出去；`remote_run` 只在这台出现 |
| **executor**（执行端） | 被要求执行工具的那台 | 在自己的会话上下文里执行转发来的调用；审批弹在**这台**上，沙箱/文件策略也用它的 |

> 旧配置里的 `server` 仍可用，等价于 `executor`；`client` 等价于 `origin`。

本机原有工具（read / write / bash / web / subagent …）全部保留，插件只是**额外增加**工具。和 PTC 不冲突：PTC 模式下模型眼里仍只有 `run_code` 一个调用工具，`remote_run` 是 `run_code` **可以调用**的工具之一；原生模式下它就是普通工具。

只转发**工具调用**（工具名 + JSON 参数 + 结果），**TS 源码不出本机**。

---

## 1. 三个工具

| 工具 | 出现在哪 | 作用 |
|---|---|---|
| `remote_run` | 仅发起端、且已连上 | 跑一段 TS，`tools.*` 转发到执行端；源码不出本机 |
| `run_ts` | 两端都有（可关） | 本机跑 TS，`tools.*` 调本机工具，`store.*` 读写共享数据空间 |
| `store.*`（程序内命名空间） | 上面两个工具的 TS 程序里 | 共享数据空间 |

连接断开（含 5 分钟空闲）时 `remote_run` **立即注销**，模型看不到；连上后再注册。

`run_ts` 是给"非 PTC 模式"补的 `run_code`：参数、提示词、结果形状都照 PTC，只是额外说明数据空间，且不占用保留名 `run_code`。

---

## 2. 安装（写用户 profile，不动 DSH 安装目录）

```powershell
node setup.mjs                                  # 只安装，模式保持 off
node setup.mjs --mode executor --port 45870     # 执行端
node setup.mjs --mode origin --host 192.168.1.23 --port 45870 --peer-token <对端 token>
node setup.mjs --show
node setup.mjs --uninstall
```

`setup.mjs` 做三件事：在 `<DSH_HOME>/profiles/<profile>/node_modules/` 下建指向本目录的链接；在 profile 的 `cordis.patch.yml` 写入/替换 `- id: lan-exec`；打印配对卡。

**模式是使用时选的**：安装只写 `mode: off`，之后在 设置 → 插件 → dsh-lan-exec 里改成 `origin` 或 `executor` 即可（HMR 直接重载），或再跑一次 `setup.mjs --mode ...`。

### 用 DSH 官方的插件安装

本包按官方 bundle 规范打包（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`），所以可以被插件管理器当成普通 bundle 安装：

```powershell
# 官方 CLI（在 PATH 里有 dsh 时）
dsh plugin --profile desktop add link:D:\path\to\dsh-lan-exec

# 或者在 设置 -> 插件 页面里安装本地目录/链接（Desktop 的包操作由外壳托管）
```

装好后 `Plugins` 页会出现 `dsh-lan-exec` 这一行（bundle 默认 `mode: off`）。再跑一次 `node setup.mjs --mode origin|executor` 只写**配置行**、不会覆盖官方安装的目录（脚本检测到非链接目录就会跳过安装，`--link` 可强制改成软链）。

> 版本兼容按"开发时所用版本"保守声明：`engines.dsh = "0.2.1-rc.5"`（DSH 的运行时版本），`dsh.manifestVersion = 1`。升级 DSH 后如果被兼容检查拦下，要么把这里改成新版本，要么用官方豁免：
>
> ```powershell
> dsh plugin --profile desktop allow-version dsh-lan-exec@1.0.0 --dsh-version <新版本> --accept-risk
> ```
>
> 或在 设置 → 插件 里对该插件授权。保守声明的意思就是：没在新版本上验过，就先别默默放行。

---

## 3. 凭证：每个请求都带（照 DSH 的做法）

两端各自生成 256 位 `dshlan_` token（和 DSH 签发凭据同强度），互换，之后**每个请求**都带自己那把：

```
POST /v1/rpc
Authorization: DshLan <本机 token>
X-DshLan-Nonce: <每次随机>
<密文信封 { method, iv, ct, tag }>
```

- 执行端用配置里的 `peerToken` 常量时间比对，不符直接 401；
- 响应带 `X-DshLan-Proof`：用**执行端自己的 token** 对 `nonce + 状态码 + body 摘要` 做 HMAC，发起端用配置里的 `peerToken` 验——所以**两边都在校验对方**；
- 请求/响应用的密钥 = `sha256(发起端 token, 执行端 token, nonce)`，AES-256-GCM，AAD 绑定方向和 `nonce`；
- `nonce` 2 分钟内不可重复，重放直接 409。

没有握手状态、没有长期会话密钥：token 只在 bearer 头里出现，执行端的 token 从不上网。

---

## 4. 共享数据空间

两端各存一份（`<DSH_HOME>/lan-exec/store.json`，格式相同）：

```ts
await store.create({ key: 'notes/a', value: { text: 'hi' } })  // 键已存在就报错
await store.update({ key: 'notes/a', value: { text: 'yo' } })  // 键不存在就报错
await store.read({ key: 'notes/a' })
await store.delete({ key: 'notes/a' })
await store.list({ prefix: 'notes/' })
await store.stat()
```

- 上限以 **executor** 的配置为准：`maxStoreBytes`，默认 `1073741824`（1024 MiB），写在 profile 配置里；发起端连接时采用执行端公布的上限。
- 单条 8 MiB，键为字符串、最长 256 字符。
- 写操作先落执行端，再落本机；重连时按 revision 合并。

---

## 5. 5 分钟空闲断开

计时从**一次调用完成之后**开始，不是从开始执行时算：

- 调用进行中不计时；
- 调用返回后开始计时，默认 300000 ms；
- 期间没有新调用 → 执行端主动关闭，发起端随即注销 `remote_run`；
- 空闲断开属于主动下线，**不会自动重连**（`autoReconnect` 只处理网络错误）。

---

## 6. 配置项（profile 的 `cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `off` | `origin` / `executor` / `off` |
| `token` | 自动生成 | **本机**凭据 |
| `peerToken` | — | **对端**凭据 |
| `name` | 主机名 | 日志与配对卡显示名 |
| `peerName` | `peer` | 写进工具描述，告诉模型对端是谁 |
| `port` | `45870` | 监听/连接端口 |
| `bind` | `0.0.0.0` | 执行端监听地址 |
| `host` | — | 发起端连接地址 |
| `session` | `auto` | 执行端用哪个会话执行：`auto` 取第一个活跃会话，或填 session id |
| `idleTimeoutMs` | `300000` | 空闲断开（调用完成后计时） |
| `autoReconnect` | `true` | 网络错误自动重连；空闲断开不重连 |
| `toolName` | `remote_run` | 转发工具名 |
| `localTool` | `true` | 是否注册 `run_ts` |
| `localToolName` | `run_ts` | 本机代码工具名 |
| `callTimeoutMs` | `300000` | 单次程序执行上限 |
| `maxStoreBytes` | `1073741824` | 数据空间上限（以 executor 为准） |
| `storeFile` | `<DSH_HOME>/lan-exec/store.json` | 数据空间文件 |
| `allowedTools` | `[]` | 非空时只允许转发列表里的工具 |
| `hideTools` | `['run_code']` | 不向发起端暴露的工具（避免递归） |

---

## 7. 本机代码怎么跑（照 PTC）

- 每段程序起一个**独立 worker 线程**，不在宿主主线程里求值；
- 类型擦除用 `module.stripTypeScriptTypes`，包装成 `async function __dsh_program__(tools, store, console)`，和 PTC 的 `function-body` 形式一致；
- `tools.*` / `store.*` 只是 RPC 桩：worker 发消息，宿主执行后回消息，所以**权限永远在宿主这一侧**；
- 超时 / 取消 / 死循环 → `worker.terminate()` 直接杀掉，和 PTC 杀掉子进程同效；
- 结果形状照 PTC：日志在前、返回值在后；失败是 `Error: program failed (<kind>): <message>`。

> PTC 用独立**进程**，这里用独立**线程**：Electron 主进程里再 fork 子进程会被打包方式限制，线程同样能做到"代码不在主线程、能强杀"。这是本项目唯一和 PTC 不同的执行取舍，已写在下面"已知取舍"。

---

## 8. 安全边界

- **凭证**：256 位随机，两端互验，每请求携带、服务端常量时间比对。
- **传输**：AES-256-GCM，密钥随 nonce 变化；重放帧 409，篡改帧解密失败。
- **权限**：转发调用走 `ctx.tools.execute`，即执行端会话的 `tools/pre-execute` 策略、审批通道、sandbox / 文件策略。**审批在执行端**。
- **代码**：TS 源码只在本机 worker 线程里执行，不随 RPC 发出。
- **范围**：`allowedTools` 白名单；执行端 `hideTools` 默认藏 `run_code`。

已知取舍：

- worker 线程与宿主同进程，隔离强度低于 PTC 的独立进程（但能强杀、不共享全局）；
- 数据空间"最终一致"：写以执行端为准，重连合并，按 revision 后写覆盖；
- UI 卡片是可选增强，加载失败自动退回通用卡片。

### UI 卡片

卡片**直接复用**官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `CodeBlock`（就是 PTC `run_code` 卡里那个代码块），行布局与 `ToolRow` 的 code 变体一致（24px 行高、13px 摘要、2px 分隔点），输出区沿用 `ioCard/ioSection/ioLabel/ioText` 的官方样式。DSH 是 MIT，样式与组件都按原样复用，只改了文案。

---

## 9. 排错

| 现象 | 处理 |
|---|---|
| 模型看不到 `remote_run` | 未连上。看 `lan-exec:` 日志；确认 `mode: origin`、`host` 可达、两端 token 互补 |
| 401 | token 填反/填成同一个；`node setup.mjs --show` 对照 |
| 409 replayed-nonce | 两台时钟或代理重放；校时后重试 |
| 连接被拒 | 执行端防火墙放行 TCP 端口（默认 45870） |
| `requires approval, but the call has no agent` | 执行端没有活跃会话：先在那台打开会话，或把 `session` 设成具体 id |
| 空闲 5 分钟就断 | 预期行为；计时从调用完成开始 |
| 卡片没变化 | UI 卡片可选；检查 Web 端是否加载了 `lib/client.js` |

---

## 10. 目录

```
lib/index.js        插件入口：配置、模式、装配
lib/server.js       executor：HTTP 服务、每请求鉴权、执行本机工具、数据空间 RPC
lib/host-client.js  origin：连接、注册/注销工具、转发
lib/client.js       origin 的浏览器侧工具卡片（可选，纯 ASCII）
lib/tool.js         remote_run 工具定义
lib/local-tool.js   run_ts 工具（PTC 文案 + 数据空间）
lib/ptc-program.js  程序运行器（worker 线程、绑定 RPC、结果形状照 PTC）
lib/worker.mjs      独立线程里的程序求值器
lib/ptc-types.js    JSON Schema -> TS 声明（照 PTC 渲染器改的）
lib/sdk.js          工具描述生成
lib/store.js        共享数据空间
lib/token.js        256 位 token
lib/wire.js         每请求鉴权、AES-GCM 信封
test/bridge.test.mjs 端到端测试（12 项）
setup.mjs           一键安装到用户 profile
cordis.patch.yml    bundle 补丁（惰性一行）
```

### 编码

`lib/*.js`、`lib/*.mjs`、`setup.mjs` 全部 **纯 ASCII + 无 BOM**，任何代码页都不会花；中文只在本 README（UTF-8）。安装卡片的框线用 `+ - |`。

### TypeScript

运行时要被 Node 直接加载，所以发布物是 `.js`；类型靠 JSDoc + `lib/index.d.ts`。PTC 的两个内部模块（类型渲染、程序运行）上游没有导出，只能改写进本包，不能 `import`。

---

## 许可与致谢

本包是 **MIT**，见 [LICENSE](LICENSE)。

部分代码改写自 **DeepSeek Harness**（同样 MIT，Copyright (c) 2026 DeepSeek），逐项清单和上游许可证全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。用到的上游包：

| 上游包 | 用在哪 | 方式 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `lib/ptc-types.js`（JSON Schema → TS 渲染）、`lib/sdk.js` / `lib/local-tool.js`（`run_code` 的描述与指令文案） | 改写 |
| `@deepseek-ai/dsh-ptc-runtime-node` | `lib/ptc-program.js`、`lib/worker.mjs`（程序包装、类型擦除流程、日志捕获、`ToolCallError`、结果形状） | 改写 |
| `@deepseek-ai/dsh-ptc-runtime` | `lib/ptc-program.js`（`resolve` / `run` 契约、绑定命名规则） | 改写 |
| `@deepseek-ai/dsh-client-ui-tool` | `lib/client.js`（code 变体的行布局与输出区样式） | 样式改写 |
| `@deepseek-ai/dsh-client-ui-primitives` | 浏览器卡片里的 `CodeBlock` | **运行时直接 require，未复制源码** |
| `@deepseek-ai/cordis` | 插件契约（`apply` / `inject` / `ctx.effect`） | 宿主 API |
