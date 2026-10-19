# dsh-plugin-balance-hud · DeepSeek 余额能量核心

常驻 DSH Web 界面上的余额徽章（`shell.overlay` 座位上的一格，点击穿透层里唯一接指针的条目）。Host 半边持有 DeepSeek API Key 并定时查询账户余额，浏览器半边把它渲染成一颗「能量核心」。

可以拖到任意位置，靠近边缘会自动缩进去，只留一条边在屏幕上。

## 安装

```bash
git clone https://github.com/jxboop/dsh-plugin-balance-hud.git
node dsh-plugin-balance-hud/install.mjs
```

PowerShell（5.1 不支持 `&&`，用分号）：

```powershell
git clone https://github.com/jxboop/dsh-plugin-balance-hud.git; node .\dsh-plugin-balance-hud\install.mjs
```

脚本是幂等的，做四件事：

1. 把插件放进 `<DSH 主目录>/plugin-src/dsh-plugin-balance-hud`
2. 在 `<profile>/node_modules` 建链接（Windows 用 junction，**无需管理员权限**）
3. 把包名写进 `<profile>/package.json` 的 `dsh.profile.bundles`（只改这一个字段）
4. 打印重启指引

然后：

1. `Ctrl+C` 停掉 `dsh web`，重新执行 `dsh web`
2. 浏览器 `Ctrl+Shift+R` 硬刷新

**为什么必须重启**：bundle 列表与宿主路由只在进程启动时装载，热加载覆盖不到新装的插件。

装好后默认出现在**右下角**（小舞桌宠上方），拖到你喜欢的位置即可，位置会被记住。

常用参数：

```bash
node install.mjs --profile web            # 指定 profile（默认 web）
node install.mjs --dsh-home D:\dsh-home    # 自定义 DSH 主目录
node install.mjs --source ./本地目录        # 从本地目录安装（改代码时用）
node install.mjs --help
```

DSH 主目录默认按 `$DSH_HOME` → `~/.dsh` 的顺序推断。

### 环境要求

| 项目 | 要求 |
| --- | --- |
| DSH | 已在跑 `dsh web`（有 `web` profile） |
| Node.js | ≥ 18 |
| git | 安装时需要 |
| 凭据 | 你自己的 `DEEPSEEK_API_KEY`，见下方「凭据解析顺序」 |

### 卸载

```bash
node dsh-plugin-balance-hud/uninstall.mjs           # 移除链接与 bundles 注册，保留插件目录
node dsh-plugin-balance-hud/uninstall.mjs --purge   # 连插件目录一起删
```

重启 `dsh web` 生效。

## 它长什么样

- **徽章**：旋转的锥形能量环 + 脉动核心，旁边是实时余额，青紫渐变数字，刷新时滚动过渡。
- **能量条**：贴在徽章底部，随余额高低伸缩变色 —— 充足青、`≤ ¥10` 琥珀、`≤ ¥1` 赤红。
- **全息面板**（点击徽章展开）：放大余额、API 可用状态、赠送余额与充值余额占比条、上次同步时刻、手动刷新。点外部或按 `Esc` 收起。
- **轮询**：收起时 45 秒一次，面板展开时 15 秒一次。
- **读取失败时**：保留最后一次已知余额（好过显示空白），但核心会转入灰暗的 `error` 态、状态行转红并说明原因 —— 读数已经陈旧，不会假装健康。

## 拖动与靠边收缩

徽章是可以摆的：

- **拖动**：按住徽章拖，松手即停；位置钳在视口内（四周留 10px），刷新后仍在原处。
- **靠边自动收缩**：松手时若离某条边 ≤ 30px，就自动缩进那条边 —— 左边就缩左边、右边缩右边、上边缩上边、下边缩下边，每次只留 22px 露在屏幕内。
- **动效**：收缩/展开是 **320ms 缓动滑动**（不是瞬间消失），文字与能量条同步 **240ms 淡出/淡入**；`prefers-reduced-motion` 下两个过渡都关闭。
- **展开**：点露出的那一条边缘，回到收缩前的位置。
- **手动收起**：徽章右缘有个半透明的 `›` 把手，点它缩进当前最近的一边（不想拖动时用）。

实现要点：

- 收缩用**像素位移的 `transform`**，布局的 `left`/`top` 始终不动 —— 浏览器自己插值，滑动方向天然正确；文字用 `opacity` 淡出但**保留盒子**，所以滑到一半不会因为宽度突变而跳一下。
- 向左收时徽章内容改成 `row-reverse`，露在屏幕边缘的是能量核心而不是文字尾巴。
- 拖动态同时把 CSS 的 `right`/`bottom` 置 `auto` —— `left`/`top` 与它们并存会让 `width: auto` 的固定元素横向拉满整帧。
- 拖动超过 4px 才算拖动；拖完浏览器补发的那次 click 会被 400ms 守卫吞掉，不会误开面板。
- 位置与收缩边存在 `localStorage`（`dsh-plugin-balance-hud:pos`、`dsh-plugin-balance-hud:tuck`），分浏览器保存；旧版只存过 `:collapsed`，读取时按「右侧」迁移。


配色沿用主题变量（`--dsw-alias-label-secondary` 等），深色与浅色主题下都可读；`prefers-reduced-motion` 下关闭全部动效。

## 两个半边

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `lib/index.js` | 解析凭据、调用 `GET /user/balance`、在固定路径上返回 JSON |
| Browser | `lib/client.js` | 在 `shell.overlay` 座位上渲染徽章（可拖动、可靠边收缩），轮询上面的路由 |

**API Key 从不进入浏览器。** 浏览器半边只请求同源的 `/plugin/balance-hud/balance`，该路由返回的是裁剪后的余额标量。

### 凭据解析顺序

1. `credentials` Cordis 服务（若该 composition 挂载了它）—— 它自己会叠乘环境变量与 provider 托管的存储；
2. 回退到分层凭据文件 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`。

解析结果按 `KEY_CACHE_MS` 缓存；若上游返回 401/403，会强制重新解析一次再重试，这样轮换密钥不必重启进程。

### 路由响应

```json
{ "ok": true, "isAvailable": true, "source": "credentials", "at": 1730000000000,
  "balances": [{ "currency": "CNY", "total": 8.14, "totalText": "8.14", "granted": 0, "toppedUp": 8.14 }] }
```

失败时返回 `{ "ok": false, "reason": "nokey|auth|network|shape|internal", "message": "…" }`。`message` 是短中文说明，**不含上游响应体，也不含密钥**。

## 座位

注册在 `shell.overlay`（frame 级叠加层里的一格），`id` 为 `deepseek-balance-core`、`order` 为 `-10`。使用自定义 id 只会**新增**一格，不会替换该座位里自带的条目；叠加层本身点击穿透，本条目只为自己重新打开指针事件。

## 挂载方式

由 `cordis.patch.yml` 插为一行 host row：

```yaml
- insert:
    - id: balance-hud
      name: dsh-plugin-balance-hud
      inject: [webServer]
```

这一行让 Cordis 挂载本包，从而（a）认领余额路由，（b）使本包进入 client-modules 扫描列表，其 `dsh.client` 声明被识别并加载浏览器半边。

`inject: [webServer]` 不是可选项：少了它，这一行会先于 web 载体激活、静默注册不到任何路由，浏览器就永远显示「信号中断」。

## 自检

```sh
node test/run.cjs
```

五项检查，各自独立：

| 检查 | 验证内容 |
| --- | --- |
| `syntax` | 两个半边都是合法 ES module，且为有效 UTF-8（无替换字符） |
| `contract` | `dsh.client` 声明、`exports["./client"]`、`__ModuleLoader__` 注册与 bundle patch 相互一致 |
| `host` | 路由注册、凭据解析顺序、上游请求构造、载荷裁剪，以及成功/失败响应都不泄漏密钥 |
| `client` | 浏览器半边能物化、只注入一份样式表、用自定义 id 占用 `shell.overlay`、轮询宿主路由，并从真实数据推导 ok / warn / danger / error 与收起态 |
| `gestures` | 拖动的阈值/跟随/钳位/持久化、拖完的 click 被吞、四条边各自吸附的锚点与位移、点边缘展开回原位置 |

`client` 用的是带渲染循环的假 DOM：`setState` 会像真实 React 一样触发重渲染，因此断言读到的是最后一次轮询真正产生的树。

## 已知边界

- 余额接口为 DeepSeek 官方 `GET /user/balance`；base URL 依次尝试 `https://api.deepseek.com` 与 `https://api.deepseek.com/v1`。
- 路由为 `exact` 精确匹配，无鉴权 —— 它只暴露账户余额数值，不含任何可用凭据。若你的 Web 服务监听 `0.0.0.0` 且不可信网络上可达，请自行在前置代理处限制该路径。
- 凭据文件回退路径会读取 `$DSH_HOME/.credentials.yaml`；测试通过临时 `DSH_HOME` 隔离，不会触碰真实凭据。
