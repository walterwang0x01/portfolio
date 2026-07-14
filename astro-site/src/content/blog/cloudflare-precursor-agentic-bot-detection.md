---
title: "Cloudflare Precursor：用会话行为堵住 Agentic Bot"
date: 2026-07-14
tags: ["AI Agent", "Agent 安全", "基础设施"]
excerpt: "Agent 已能执行 JS、通过单次 CAPTCHA，再用直线鼠标完成整段业务流程。Cloudflare Precursor 把检测从「单请求指纹」抬到「全旅程会话行为」——对外 MCP/插件入口与开放 API 的团队，本周该重新对照 Bot 规则。"
emoji: "📡"
vip: false
draft: true
---

过去几天的简报里，一边是 ChatGPT Work 把「跨应用多小时交付」推成产品默认叙事，另一边是 Cloudflare 发布 **Precursor**：专门对付「像人一样点、其实是 agent」的高级自动化。同一周还有 Canopii《State of MCP Security 2026》、蚂蚁面向编码智能体的安全框架、Anthropic MCP Tunnels API 迁路径——合在一起说明一件事：**Agent 已经同时站在进攻面和暴露面两侧**。你既要让自家 Agent 去调用别人的服务，也要假设别人的 Agent 会来敲你的门。

如果你对外挂了 MCP 目录、插件市场、可脚本化的 Web App 或开放 API，单靠「拦旧式爬虫」已经不够。Precursor 的价值不在又多了一种挑战题，而在把防御单位从**单次请求**改成了**整段会话**。

## 为什么旧 Bot 规则会被 Agent 绕过

传统 Bot Management 擅长三件事：IP/ASN 信誉、TLS/JA3 指纹、Turnstile 这类关键节点挑战。Agent 与 RPA 的新常态正好打在这些短板上：

| 旧假设 | Agentic 现实 |
|--------|--------------|
| 不会跑真实浏览器 | Agent 用真实 Chromium / Playwright，能执行 JS |
| 过不了 CAPTCHA | 可在短 burst 内通过单次挑战，再继续自动化 |
| 请求模式怪异即可拦 | 单请求看起来合法，异常藏在「整段旅程」节奏里 |
| User-Agent / IP 黑名单够用 | 住宅代理 + 合法 UA + 似人点击脚本组合出现 |

Cloudflare 官方说法很直白：现代自动化能在短时间内「看起来合法」；难伪造的是**跨时间、跨页面的一致人类行为**。Precursor 正是把客户端连续信号沉淀成会话级特征，再回灌到 bot score 与安全规则里。

## Precursor 怎么工作（工程视角）

可以把 Precursor 拆成四层，方便对照你现有的 WAF / Bot 栈：

1. **注入与采集**：开启后，Cloudflare 在 HTML 响应里自动注入轻量脚本，监听 pointer、键盘节奏、聚焦与可见性等交互；数据在内存缓冲，定期回传。对应用侧几乎零改代码。
2. **边缘评估**：边缘侧反序列化载荷，多路 evaluator 交叉校验（例如指针活动和页面可见时长是否相关、键盘事件是否只在输入框聚焦时出现）。
3. **会话累积**：信号按 session 累积；刷新页面或重启挑战**不能**轻易洗掉行为画像——这对「刷挑战后继续脚本」的 agent 路径尤其关键。
4. **隐私约束**：键盘只记 timing/rhythm，不记真实按键内容；信号供内部检测，不落用户账号档案。

对运营侧，Security Analytics 新增了**会话视角**：典型会话长什么样、何处偏离、哪些 session 长时间像自动化。这比「单请求 bot score」更贴近「一个 agent 是否走完了下单/接入/调用工具整条链路」。

开启策略上，官方给出两种姿态：低摩擦观察（shadow / 背景打分），或要求会话已验证否则补 Challenge。Precursor 属 Enterprise Bot Management 能力，并与 Turnstile 互补——Turnstile 守登录/支付等关键门，Precursor 补门与门之间的旅程。

## 对 Agent 工程意味着什么

### 对外业务：把「agentic 会话路径」写进规则

不要只在 `/login`、`/checkout` 挂挑战。Agent 更常攻击的是：

- MCP / 插件 OAuth 回调与 token 交换
- 批量工具调用入口（`/tools/*`、`/mcp`、WebSocket 升级）
- 可触发副作用的表单：创建 API Key、邀请成员、改计费

建议把路径分级，再决定「观察 / 加严 / 拒绝」：

```yaml
# 示意：会话风险 × 路径敏感度 → 动作
routes:
  - path: /mcp/*
    sensitivity: high
    on_high_bot_score: challenge_or_block
  - path: /api/public/search
    sensitivity: low
    on_high_bot_score: rate_limit
  - path: /oauth/callback
    sensitivity: critical
    require_verified_session: true
```

同一天简报里的 MCP 安全报告强调协议默认「授权可选」、供应链与运行时验证欠账——**检测层**（Precursor）和**授权层**（EMA / 最小权限）必须一起上；只开行为检测却不收紧 MCP 权限，等于看到了异常却拦不住落盘命令。

### 对内 Agent：诚实声明 + 付费通道

如果你的产品是「合法 Agent 客户」，也要对齐新现实：对方站点可能用会话行为抬高自动化成本。工程上更稳的路径是：

- 走官方 bot / agent 分类与机器可读策略，而不是伪装成人机会话
- 对高价值 API 预留 x402 / API Key / 合同通道（本周 Cloudflare 与 AWS 边缘也在推 x402）
- 长时任务用可审计身份，而不是共享一个浏览器 Cookie 池

伪装成人会越来越贵；把自己声明成 Agent 并买「可调用额度」，反而更可持续。

## 最小落地 checklist

下面这份清单可直接贴进本周安全/平台 standup：

| 步骤 | 做什么 | 验收标准 |
|------|--------|----------|
| 1 | 盘点对外 HTML + MCP/插件入口 | 有清单：域名、路径、是否经 Cloudflare |
| 2 | 先 shadow 开 Precursor | 一周内能在会话分析里标出高风险 session |
| 3 | 关键写操作绑定 verified session | OAuth、发 Key、改成员必须带挑战或已验证会话 |
| 4 | Bot score 接入现有规则 | `cf.bot_management.score` 等字段已用于 WAF |
| 5 | 合法 Agent 走独立通道 | 服务账号 / mTLS / 付费网关，与浏览器会话隔离 |
| 6 | 对内红队 | 用 Playwright +「拟人噪声」脚本压测，看是否仍被打入高风险 |

Python 侧如果你自建网关（非 Cloudflare），至少要把「单请求特征」升级为「会话累加」——思路与 Precursor 同构：

```python
from dataclasses import dataclass, field
from time import time

@dataclass
class SessionBehavior:
    session_id: str
    pointer_samples: list[tuple[float, float, float]] = field(default_factory=list)
    key_intervals_ms: list[float] = field(default_factory=list)
    focus_ms: float = 0.0
    visible_ms: float = 0.0

    def add_pointer(self, x: float, y: float, t: float) -> None:
        self.pointer_samples.append((x, y, t))

    def linearity_score(self) -> float:
        """越接近 1，轨迹越「尺规作图」——疑似脚本。"""
        pts = self.pointer_samples
        if len(pts) < 3:
            return 0.0
        dx = pts[-1][0] - pts[0][0]
        dy = pts[-1][1] - pts[0][1]
        straight = (dx * dx + dy * dy) ** 0.5
        path = 0.0
        for i in range(1, len(pts)):
            path += ((pts[i][0] - pts[i - 1][0]) ** 2 + (pts[i][1] - pts[i - 1][1]) ** 2) ** 0.5
        if path == 0:
            return 1.0
        return min(1.0, straight / path)

    def risk(self) -> float:
        # 示意加权：高线性 + 键盘过匀 + 可见时长与操作脱节 → 抬高风险
        lin = self.linearity_score()
        key_var = 0.0
        if len(self.key_intervals_ms) > 2:
            mean = sum(self.key_intervals_ms) / len(self.key_intervals_ms)
            key_var = sum((v - mean) ** 2 for v in self.key_intervals_ms) / len(self.key_intervals_ms)
        low_variance_penalty = 1.0 if key_var < 25 else 0.2
        visibility_gap = 1.0 if self.visible_ms > 0 and self.focus_ms / max(self.visible_ms, 1) < 0.05 else 0.0
        return min(1.0, 0.5 * lin + 0.3 * low_variance_penalty + 0.2 * visibility_gap)


def gate(path: str, behavior: SessionBehavior, threshold: float = 0.72) -> str:
    score = behavior.risk()
    if path.startswith("/mcp") and score >= threshold:
        return "challenge"
    if score >= threshold:
        return "rate_limit"
    return "allow"
```

真实生产应把 evaluator 放边缘、用加密通道回传、避免在业务日志里落原始轨迹；上面只是「从请求维度升级到会话维度」的骨架。

## 和同日其他信号怎么拼图

- **ChatGPT Work / 长时 Agent**：合法流量也会变成多小时、多标签页会话——规则要区分「生产力 Agent」与「欺诈 Agent」，不要一刀切挡掉全部自动化。
- **MCP 安全现状 + 蚂蚁编码 Agent 框架**：行为检测是外环，权限与供应链是内环；缺一不可。
- **x402 边缘微支付**：对爬取与工具调用，从「白嫖 vs 封杀」过渡到「可审计计费」；与 bot score 可以形成双杠杆。

## 本周行动建议

1. **今天**：列出所有经 CDN 暴露的 HTML 应用与 MCP/插件回调域名；确认是否已在 Cloudflare Bot Management 覆盖面内。
2. **本周**：对非生产或 staging zone 开启 Precursor 观察模式，导出一周高风险会话样本，标出误杀候选（自家 E2E、合作方 Agent）。
3. **下周**：把 `verified session` 绑到三类写操作（发凭证、改权限、计费变更）；为合作 Agent 开通独立凭证通道，禁止它们走「仿人浏览器」主路径。
4. **持续**：把会话级误报/漏报纳入安全每周评审，和 MCP Server 权限审计同一议程，避免「检测侧看到了、授权侧仍全开」。

Agent 时代的边缘防御，正在从「挡爬虫」转向「建模会话」。Precursor 不是终点，但它把正确的抽象钉进了基础设施——**谁先按会话而不是按请求治理开放面，谁就能在 agentic 流量爆发时少付一笔学费**。
