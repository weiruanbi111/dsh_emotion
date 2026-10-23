# dsh-pet 对外 HTTP 接口一览

dsh-pet 的宿主半侧向 DSH 自己的 Web 服务注册了**一条前缀路由** `/dsh-pet-7340`，浏览器端、
桌面端、设置页与第三方插件全都访问同一份实现。本文只做**功能预览**（接口名 + 一句话），
完整契约——参数、响应体、字段含义、错误码与示例——见根目录的 [`openapi.yaml`](openapi.yaml)。

- **基址**：`http://127.0.0.1:<port>/dsh-pet-7340`，`<port>` 是 DSH Web 服务实际监听的端口
- **只监听 127.0.0.1，且没有鉴权**：任何能访问本机该端口的进程都能调用，请勿转发到公网

---

## 一、读状态

| 接口                             | 功能                                                               |
| -------------------------------- | ------------------------------------------------------------------ |
| `GET /dsh-pet-7340/state`        | **轮询唯一数据源**：一次拿到说话、工作状态、系统通知、余额四类状态 |
| `GET /dsh-pet-7340/config`       | 读合并后的成品配置（内置默认 + 用户层，字段已填满）                |
| `GET /dsh-pet-7340/config/meta`  | 配置文件路径、各类数据落盘位置、卸载该用哪个 profile               |
| `GET /dsh-pet-7340/models`       | 可用服务商与模型清单（与 DSH 自己的模型选择器同源）                |
| `GET /dsh-pet-7340/chat?pet=`    | 读某只桌宠最近的对话记忆窗口                                       |
| `GET /dsh-pet-7340/emotion?pet=` | 检查已有宠物当前的连续模拟情绪与全局开关（pet 必填，无模型调用）   |

## 二、让桌宠做事

| 接口                                    | 功能                                                                |
| --------------------------------------- | ------------------------------------------------------------------- |
| `POST /dsh-pet-7340/whisper?pet=`       | 让桌宠**生成**一句碎碎念（走当前模型）                              |
| `POST /dsh-pet-7340/broadcast?pet=`     | **第三方投喂**：把外部给定的文本直接写进气泡（不生成，只搬运）      |
| `POST /dsh-pet-7340/anim?pet=`          | **点播动画**：让桌宠播一段指定动画，效果与右键「动作」菜单一致      |
| `POST /dsh-pet-7340/chat?pet=`          | 对桌宠说一句话并生成回复，同时写入对话记忆                          |
| `POST /dsh-pet-7340/balance`            | 立即刷新一次余额                                                    |
| `POST /dsh-pet-7340/reload`             | 重载桌面端（重启桌面宠物进程，按最新配置重建窗口）                  |
| `POST /dsh-pet-7340/emotion/reset?pet=` | 将指定宠物情绪重置到基线；省略 pet 重置全部，保留人工与自动互动冷却 |

## 三、改配置

| 接口                        | 功能                                                   |
| --------------------------- | ------------------------------------------------------ |
| `PUT /dsh-pet-7340/config`  | 保存用户层配置（白名单重建，用户手写的精调字段会保留） |
| `POST /dsh-pet-7340/config` | 用内置默认整份覆盖用户配置，即「恢复默认」             |

`main.emotionEnabled`（默认 `true`）启用连续情绪上下文与已有动画映射；关闭后保留基本功能。
`main.doNotDisturb`（默认 `false`）暂停自动碎碎念、工作状态气泡与动画、系统通知和自动余额刷新，
手动聊天、手动碎碎念与手动余额查询仍可使用。已显示的说话气泡按原时长结束。
这两个字段为严格布尔值，通过现有 `PUT /config` 保存；未提交的字段与既有高级配置会保留。

## 四、素材

| 接口                                     | 功能                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| `GET /dsh-pet-7340/thumb/{petId}/{file}` | 动画素材（`.webm` / `.mov`，按宠物归属）                        |
| `GET /dsh-pet-7340/font/{file}`          | 字体文件                                                        |
| `GET /dsh-pet-7340/pic/{file}`           | 通知图标（`pic/`）与表情包（`pic/memes/{素材根}/`，按宠物归属） |

---

## 三条要记住的约定

1. **播放数据统一从 `GET /state` 读取**。它返回宿主内存里的已发布状态，每个状态位是
   `{ counter, data }`。
2. **播放动作端点不返回数据**：`POST /balance`、`POST /whisper`、`POST /broadcast`、`POST /anim`、
   `POST /chat` 只回 `{ ok: true }`，表示"动作做完了"；
   结果写进状态，调用方随后拉一拍 `/state` 即可看到（立刻补拉就是 0 延迟，不必等下一个轮询周期）。
3. **`counter` 变了才渲染**：它是 `Date.now()` 且严格递增，宿主重启也不会倒退。
   状态位的路径（如 `sections.balance`、`pets.<id>.say`）请当作**不透明键**使用——
   宠物 id 允许含点号，**不要按 `.` 切分**。

情绪检查使用独立的 `GET /emotion?pet=<id>`，返回
`{ ok: true, enabled, doNotDisturb, state: { valence, arousal, updatedAt, label }, build: { id, version } }`，并带
`Cache-Control: no-store`。`valence` 范围为 `[-1, 1]`，`arousal` 范围为 `[0, 1]`，
`updatedAt` 为 Unix 毫秒，`label` 为 `calm`、`cheerful` 或 `subdued`。这些是宠物的模拟状态，
不代表用户的情绪或状态。缺少 pet、空值或未知宠物返回 HTTP 400 与 `{ ok: false, reason: 'unknown-pet' }`。

MVP 1.1 在设置页提供按需展开的「本地情绪诊断」，复用上述查询并加 `diagnostics=1`。
新增详情要求真实 loopback 连接、本机 Host、同源 Origin/Referer、浏览器 `Sec-Fetch-Site: same-origin`
及 `X-Dsh-Pet-Diagnostics: 1`；不满足返回 HTTP 403。桌面 bridge 不提供详情。
DSH 原生代理会移除 Origin 与 Sec-Fetch-Site，Chromium 也可能不提供 Referer。原生分支仅允许这两个头均缺失、
Referer 缺失或精确为无凭据/端口/查询/片段的 `dsh-app://app/`，且上述 loopback、Host、自定义头仍满足的请求。
原生分支还必须通过宿主现有 `connection.requestRejection` 的签名会话与有效 Peer 验证；方法缺失或抛错时拒绝。
不新建令牌，不读取、记录或暴露 Cookie。非空 Origin、浏览器 Fetch Metadata 或冲突 Referer 不能走此分支。
这是本机来源保护，不是登录身份认证；本机脚本仍可构造请求。普通状态查询的兼容行为不变。
`diagnostics` 返回 `{ capacity: 80, lifetime: 'process', records }`，每条只含序号、时间、事件/原因枚举、
接受与否、前后数值、表达策略和已有动画名。最多 128 只宠物各 80 条，重启清空，不落盘，
不记录会话标识、聊天原文、完整提示词、模型回复、错误正文或密钥。重复刷新不调用模型、不重复生成记录；
实际经过时间造成的衰减可记录。诊断正常不代表模型质量或真实窗口体验通过。

宿主完成只代表执行回合结束，不是用户确认成果。其增量为 `(+0.08, +0.04)`，同一会话十分钟
固定窗最多接受三次，之后记录 `session-completion-limit`。该短期控制元数据是有界摘要，不改聊天记忆结构。

自动碎碎念另有独立的短期内容避重：三十分钟内每只宠物最多保留十六个规范化 SHA-256 摘要，
总宠物上限一百二十八；摘要及时间写入 `whisper-content.json`，不存原文。按 NFKC、大小写、
空白及标点归一做匹配，不声称识别语义近似。仅在原有生成后门控全部通过时检查；重复静默丢弃，
不为避重额外调用或重试模型，保留已消耗的冷却。手动聊天和手动碎碎念均不检查或写入这份避重表。

`POST /emotion/reset` 只回 `{ ok: true }`，不改配置、不清聊天记忆，保留人工与自动互动冷却；
提供空值或未知 pet 返回同样的 HTTP 400。两个情绪端点使用错误方法时返回 HTTP 405。
说话载荷 `pets.<id>.say.data` 可带 `emotionAnimation: string | null`：缺失时沿用原说话动画，
`null` 时只显示文字并保留当前动画；映射缺失或无效时也按纯文字降级。

## 快速试一下

```bash
BASE=http://127.0.0.1:<port>/dsh-pet-7340

# 拉一次状态（只读、零副作用，可以随便轮询）
curl -s $BASE/state

# 让桌宠说一句外部给的话，然后立刻回读状态
curl -s -X POST "$BASE/broadcast?pet=main" \
     -H 'content-type: application/json' \
     -d '{"text":"巡检完毕，一切正常"}'
curl -s $BASE/state   # → pets.main.say.data.text

# 让它播一段动画（名字取自 GET /config 里**该宠物所属条目**的 animations：
#  main 条目的宠物用 main 的池，pet/<名>-config.json 的种类各用自己的池）
curl -s -X POST "$BASE/anim?pet=main" \
     -H 'content-type: application/json' \
     -d '{"name":"东张西望"}'
```

## 独立模式（不打开 DSH）

不启动 DSH 时，同一份 `/dsh-pet-7340` 契约由一个本机 HTTP 服务提供（`src/standalone/server.ts`，
用法见 [`dsh-pet/README.md`](dsh-pet/README.md) 的「🧍 独立运行（完全不打开 DSH）」）：

```bash
BASE=http://127.0.0.1:3080/dsh-pet-7340   # 独立模式默认端口 3080（被占用则顺延）
```

**上表所有端点与约定在这里完全不变** —— 独立模式把插件的宿主半边跑在伪 ctx 上，
路由表仍是 `src/host/index.ts` 那一份（桌面助手照旧走 bridge 管道）。因此本文件与
[`openapi.yaml`](openapi.yaml) 描述的 `/dsh-pet-7340` 契约**不需要为独立模式做任何改动**。

独立模式另外多两个只属于该服务的运维端点（不在 `/dsh-pet-7340` 前缀下，故不在 OpenAPI 契约里）：

| 端点                   | 说明                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `GET /`、`GET /health` | 服务与插件信息：名称、插件根与版本、监听端口、已运行秒数                                |
| `POST /shutdown`       | 优雅停机：释放插件注册的 effect（停止桌面助手、清掉周期定时器）后关闭服务，进程退出码 0 |

依赖 DSH 的能力在独立模式下**明确降级**（结构化失败，不假装成功）：`POST /whisper`、`POST /chat`
回 `{ ok: false, reason: 'provider-missing' }`（没有模型服务），`POST /balance` 回
`{ ok: false, reason: 'unsupported' }`，`GET /state` 的各状态位保持空闲初始值。

## 相关

- [`openapi.yaml`](openapi.yaml) —— 完整契约（OpenAPI 3.1，可直接导入 Swagger UI / Postman）
- [`tools/api-tester.html`](tools/api-tester.html) —— 桌宠控制台：扮演第三方消费方的示例页面，
  可直观试用上述接口（用 `node tools/api-tester.cjs` 启动，它会带上本地代理解决跨域）
