---
title: "AsyncAPI npm 被攻陷：OIDC Provenance 证明不了源码可信"
date: 2026-07-16
tags: ["基础设施", "Agent 安全", "工程化"]
excerpt: "攻击者借误配的 pull_request_target 偷走 CI token，经项目自有发布流水线把后门包推上 npm，还带着合法 OIDC provenance。Provenance 只锚定「谁发的」，不锚定「当时源码是否干净」——Agent/MCP 依赖栈同样踩这个坑。"
emoji: "⛓️"
vip: false
draft: true
---

7 月 14 日，AsyncAPI 四个高下载 npm 包在约 80 分钟内被推上五个带后门的版本。载荷不是 `postinstall`，而是在 `import` / `require` 时从 IPFS 拉 Miasma 变种；更刺眼的是，这些包带着**合法的 Sigstore / SLSA provenance**——因为攻击者劫持的是项目自己的 GitHub Actions 身份，而不是直接盗 npm token。

这和「README 诱导 npx」或 MCP STDIO 命令注入不是同一条链：前者打的是**开发者安装习惯**，后者打的是 **Client fork 边界**。AsyncAPI 事件打的是第三层：**CI 身份被当成包可信证明**。做 Agent / MCP 工具链的人同样依赖 npm 生态；若你的信任模型停在「有 provenance = 安全」，本周该改掉。

## 攻击链：pwn-request → 合法流水线 → 合法签名

公开复盘（Chainguard / Socket / Wiz）把链路收成五步：

1. 攻击者对 `generator` 仓刷大量 PR，掩盖真正利用的 #2155。
2. 误配的 `pull_request_target` 工作流在**受信上下文**里 checkout 了不可信 PR 代码，泄露高权限 PAT。
3. 持 token 者向主分支推恶意提交，触发项目**自有**发布流水线。
4. 流水线用 OIDC 换 npm 发布权，产出带 provenance 的 `@asyncapi/*` 恶意版本。
5. 开发机 / CI 一旦 `require` 受影响包，载荷驻留并偷 npm/GitHub/云凭证与浏览器密码。

| 包 | 恶意版本 | 建议回退 |
|----|---------|---------|
| `@asyncapi/generator` | 3.3.1 | 3.3.0 |
| `@asyncapi/generator-helpers` | 1.1.1 | 1.1.0 |
| `@asyncapi/generator-components` | 0.7.1 | 0.7.0 |
| `@asyncapi/specs` | 6.11.2 / 6.11.2-alpha.1 | 6.11.1 |

> Provenance 回答的是「这个工件是不是由某条流水线、某个身份发出的」；它**不**回答「那条流水线当时构建的源码是否被劫持」。CI 身份被窃 = 签名仍「合法」。

同类模式并不新鲜：`tj-actions/changed-files` 的 secrets 泄漏、以及 2026 年内至少第三次高下载量 npm 命名空间的 pwn-request 事件，都指向同一失败类——**`pull_request_target` + checkout PR head**。AsyncAPI 侧更扎心的细节是：相关误配在攻击前约 58 天就被内部标出，修复 PR 未合并。

## 为什么「装包钩子扫描」会漏检

传统供应链扫描常盯 `preinstall` / `postinstall`。这次三个恶意 `package.json` **没有** install 脚本；后门藏在看起来正常的 `validator.js` / `utils.js` / `ErrorHandling.js`（大量尾部空白），`specs` 的 `index.js` 则更直白。触发点是：

```bash
# 装上 lockfile 里的恶意版本 ≠ 立刻中招
npm ci

# 真正执行 payload 的时刻：任意进程加载模块
node -e "require('@asyncapi/generator')"
# CI 类型检查、codegen、Agent 工具导入，都会走到这里
```

因此：**lockfile 命中恶意版本就要按已感染处置**，不能因为「没跑 postinstall」「本机没看到 sync.js」就放过。曾在 07:10–08:30 UTC（7/14）窗口拉过这些版本的 CI runner、开发机，默认需要凭证轮换。

载荷落地后更像「单机 RAT」而不是蠕虫：窃取浏览器密码与 cookie、SSH 密钥、npm / GitHub CLI token、云厂商凭证与钱包数据；在应用数据目录放下 `sync.js`，Linux 上还会挂 systemd user service。C2 走 HTTP、Nostr、以太坊合约指令与 P2P 多通道——封一条出口不够。这对 CI 意味着：**哪怕 runner 是 ephemeral，被偷走的长生命周期 token 仍能在 runner 销毁后继续用**。

## Provenance 该降级成什么

把常见「信任信号」拆开看，能避免下次再把可追责当成可信任：

| 信号 | 实际证明的事 | 本次事件里是否失效 |
|------|-------------|-------------------|
| npm 账号 2FA | 人类发布者本人 | 未走人类 npm 登录，绕过 |
| OIDC + provenance | 某 GitHub 身份的流水线发的包 | **未失效**——身份正是被劫持的官方流水线 |
| SLSA「谁构建」 | 构建系统与触发者 | 同左，只追责不验内容 |
| 源码树比对 / rebuild | 发布物与公开 tag 一致 | **挡住了**（Chainguard 等因此拒发） |
| 新版本冷却窗口 | 降低「刚投毒立刻被全网拉」概率 | 缩短暴露窗口，不替代比对 |

工程结论很朴素：**签名证明身份，比对证明内容；两者缺一不可**。OIDC 消灭的是「长期 npm token 躺在 secrets 里」一类问题，消灭不了「流水线本身被 pwn」。

## 工程侧：把「身份」和「内容」拆开验

下面是一套可直接塞进 Node monorepo / Agent 依赖闸门的最小策略。

### 1. 立刻止血

```bash
# 查 lockfile / node_modules
rg '@asyncapi/(generator|generator-helpers|generator-components|specs)@' \
  package-lock.json pnpm-lock.yaml yarn.lock 2>/dev/null

npm install @asyncapi/generator@3.3.0 \
  @asyncapi/generator-helpers@1.1.0 \
  @asyncapi/generator-components@0.7.0 \
  @asyncapi/specs@6.11.1 --save-exact

# 清镜像与本地缓存后再装，避免脏 tarball 复用
npm cache clean --force
```

若确认加载过恶意版本：删掉平台路径下的 `sync.js`（Linux：`~/.local/share/NodeJS/`；macOS：`~/Library/Application Support/NodeJS/`），再按 **npm → GitHub → SSH → 云厂商 → 浏览器密码** 顺序轮换。出口侧可临时拦 `85.137.53.71` 并监控 IPFS / `rentry.co` 类回传。

### 2. CI 策略：冷却 + 钉死 + 禁止危险 Actions 模式

```yaml
# 伪策略：新版本冷却 + 精确钉版本（示意）
# allowlist 里只接受已审计 digest / 已冷却 N 小时的版本
permissions:
  contents: read   # 默认最小
  id-token: write  # 仅真正需要 OIDC 发布的 job 才开

# 禁止：pull_request_target + actions/checkout@ 引用 PR head SHA
# 允许：pull_request（只读 fork 上下文）或显式 label 后的人工晋升流水线
```

对维护开源仓的团队：把 `pull_request_target` 当成高危原语——**只要 job 会执行来自 PR 的代码或脚本，就不要给它仓库 secrets**。对消费方：锁定精确版本、开启 registry cooldown / malware scan（Chainguard 等「源码比对失败则拒发」能挡住这类「签名合法、内容已脏」的包）。

也可以在 CI 里加一层「加载即告警」的轻量探针，专门抓「无 install 脚本但仍执行副作用」的包：

```typescript
// ci/assert-no-asyncapi-malware.ts
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BAD = [
  ["@asyncapi/generator", "3.3.1"],
  ["@asyncapi/generator-helpers", "1.1.1"],
  ["@asyncapi/generator-components", "0.7.1"],
  ["@asyncapi/specs", "6.11.2"],
];

const require = createRequire(import.meta.url);
for (const [name, bad] of BAD) {
  try {
    const ver = require(`${name}/package.json`).version as string;
    if (ver === bad || ver.startsWith(`${bad}-`)) {
      throw new Error(`blocked compromised ${name}@${ver}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("blocked")) throw e;
  }
}

const drop = join(homedir(), "Library/Application Support/NodeJS/sync.js");
if (existsSync(drop)) {
  throw new Error(`miasma dropper present: ${drop}`);
}
```

### 3. Agent / MCP 依赖面要单独盘点

Coding Agent、MCP Server、codegen 插件经常间接依赖 `@asyncapi/*` 一类「看起来偏基础设施」的包。开发机上的 Agent 常年挂着 shell、读 `~/.npmrc`、用 GitHub token 开 PR——**正好是 Miasma 最想偷的那批密钥**。建议在依赖 SBOM 里加一列**加载时机**：

| 依赖用途 | 典型加载点 | 风险备注 |
|---------|-----------|---------|
| 事件 API codegen | CI `npm run generate` | 每次流水线必 require |
| MCP 工具包装 | Agent 启动 / 热加载工具 | 开发机常驻进程中招面大 |
| 文档站点构建 | `astro build` / SSG | 构建机密钥同样值钱 |

和已有的 [MCP STDIO 供应链安全](/portfolio/blog/mcp-stdio-supply-chain-security/) 对照：STDIO 文强调 Client 侧 command 白名单；本文强调 **registry 侧「签名合法 ≠ 内容可信」**。两边都要做，才算完整的 Agent 工具供应链。

> 对 Agent 栈：「工具包有 provenance」只说明发布身份可追溯，不替代**版本钉死、冷却窗口、装后行为扫描、凭证短生命周期**。

## 行动建议（本周可做完）

1. **盘点**：全仓与 CI 缓存搜四个 `@asyncapi` 包；命中恶意版本 → 当主机失陷，先清 payload 再轮换密钥。
2. **钉版本**：回退到上表安全版本，`--save-exact`，并清 registry 镜像缓存。
3. **审 Actions**：全组织搜 `pull_request_target`；禁止在受信上下文执行 PR head；发布 job 与 PR 校验 job 物理拆分。
4. **改信任模型**：把「有 OIDC provenance」从「可信任」降级为「可追责」；内容可信靠源码比对、冷却、签名**且**构建输入完整。
5. **Agent 供应链**：把 MCP / codegen / Agent 插件依赖纳入与业务应用同一套 npm 闸门，而不是「本机工具可以例外」。

本周简报的趋势句写得很准：**CI 身份 ≠ 包可信**。AsyncAPI 用一次带合法 provenance 的后门，把这句话钉进了生产 checklist。
