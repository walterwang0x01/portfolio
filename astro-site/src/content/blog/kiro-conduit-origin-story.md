---
title: "kiro-conduit 起源故事：开 5 个分支两天没合上代码，于是我做了个并行编排器"
date: 2026-05-29
tags: ["AI Agent", "AI Coding", "工程化", "开源"]
excerpt: "市面上至少有 9 个并行 AI coding 编排器，但没一个支持 Kiro CLI。我从开 5 个 git worktree 手动并行做 11 个 PR、merge 时一身冲突的痛点出发，用一个周末做出了 kiro-conduit——基于 CIV 三角色 + ACP 协议的 Kiro 原生编排器。本文讲设计决策、踩到的暗礁、跑通的实测数据，以及为什么不该重复造大多数轮子但偶尔值得造一个。"
vip: false
draft: false
emoji: "🚇"
---

## 起点：一份跑了两天还没收敛的 spec

2026 年 5 月的某个工作日，我在做一个跨多模块、跨两个仓库的大型后端系统改造。spec 拆成了 9 个阶段、约 18 个 PR，工时预估 9-13 天。

第一天：Kiro 一个 PR 一个 PR 串行干活，我盯着进度条心想"这才推到 PR 5.x，剩下 11 个 PR 想是跑不完的"。第二天傍晚，我手动开了 5 个 git worktree、5 个分支（`feature/pr-6.2` 到 `feature/pr-7.5`），每个窗口跑一个 Kiro IDE。

并行的速度感是有了，但代价立刻浮现：

1. **冲突频发**——多个分支同时改 `constants.py` / `db_init.py` / `main.py` 这种"hub 文件"，merge 时人脑做语义合并，错一行就埋雷
2. **接口飘移**——多个并行 PR 都依赖同一个核心 builder 类，但各自实现的接口签名不一致，merge 后才发现
3. **review 流程靠手**——每个 PR 我都要手动起 Kiro CLI 跑 reviewer，写 round1 / round2 prompt
4. **进度不可见**——5 个窗口在跑，我得来回切 IDE 看哪个卡了
5. **跨仓库尴尬**——Kiro 一个 session 一个 cwd，两个仓库不能同时改

到了晚上我自己手写了一份"多窗口并行 spec"作为调度指引。**写到一半意识到，这本质上是用人脑模拟一个并行编排器**：用脑子做 DAG 调度、用约定做共享文件锁、用 stash 做隔离。这一刻我决定——这件事要工具化。

## 先做调研，确认不是在重复造轮子

写代码之前，先花一小时搜了一遍。**结论让我意外又不意外**：

这个赛道在 2026 年已经很卷。我列了 9 个开源/商业并行编排器：Conductor (YC S24)、Augment Intent、microsoft/conductor、ryanmac/code-conductor、Claude Squad、Vibe Kanban、Devin、Cursor Background Agents、GitHub Spec Kit。它们都在做"git worktree + 多 agent 并行 + 串行 merge"这套事。

**但没有一个支持 Kiro CLI**。

它们要么绑定 Cursor / Claude Code / Augment / Copilot，要么需要按 vendor 自己的 SDK 接入。Kiro 用的是开放协议——[Agent Client Protocol (ACP)](https://agentclientprotocol.com/)，理论上任何编排器都能接，**但没人做**。

这个空白对我来说意味着两件事：

1. **不是重复造轮子**——我做的是给 Kiro 生态填一块明显缺失的拼图
2. **不发明新模式**——并行 AI coding 编排的最佳实践已经有共识，我只需要把行业共识落到 Kiro 上

## 设计原则：6 大模式，一个不发明

这点是我一开始就想清楚的：**任何不在 6 大模式之内的"创新"都要被打回**。

这 6 大模式是 [Augment Code 在 2026 年 3 月](https://www.augmentcode.com/guides/how-to-run-a-multi-agent-coding-workspace) 总结、并被 VeriMAP（EACL 2026）和 Anthropic 多 agent 研究系统反复验证的行业共识：

1. **Spec-Driven Decomposition** —— spec 是唯一真相，agent 不自由发挥
2. **Git Worktree Isolation** —— 每个 agent 自己的工作目录，物理隔离
3. **Coordinator / Implementor / Verifier (CIV)** —— 三角色分工，单 agent 不可能同时写好规划 + 执行 + 审查
4. **BYOA Model Routing** —— Coordinator 用强模型，Implementor 用便宜模型
5. **Multi-Layer Verification** —— lint → test → AI review，便宜的检查在前
6. **Sequential Merge** —— 串行 merge + rebase，不试图自动解语义冲突

为什么是 6 而不是 7？因为这 6 个模式覆盖了 4 类经典失败：

| 失败模式 | 检测难度 | 由哪个模式兜底 |
|---------|---------|----------------|
| Merge 冲突（同行） | 低（git 立即报） | 模式 2 + 模式 6 |
| 重复实现 | 中（要跨分支看） | 模式 1 + 模式 3 |
| 语义矛盾（编译过但运行错） | 高（lint/test 都过） | 模式 5 + 模式 6 中的人工 review |
| 上下文耗尽 | 中（输出质量降级） | 模式 1 + 模式 3 |

任何想加第 7 个模式的人都该先回答：它兜底的是哪类失败？已有 6 个里没人覆盖吗？

## 一个非典型设计点：接口锁定（Stub-First）

6 大模式之外，我从自己手动并行的痛点里**抽出了一个差异化设计**：接口锁定。

并行最大的隐形 bug 不是文件冲突——是**接口飘移**。三个 PR 都说"我用 LedgerEntryBuilder"，但三个人对它的方法签名理解不同，merge 之后跑测试才发现签名对不上。

我的解法是 **stub-first 编排**：DAG 里某个阶段开始并行前，先派一个 Implementor 跑"接口包"任务——只写接口 stub（class + method 签名 + docstring，函数体 raise NotImplementedError），写完 commit 到 base 分支。然后**所有下游并行 task 从这个 base 分支起 worktree**，看到的接口是冻结的。最后 Verifier Layer 4 做契约校验，检查它们没偷偷修改签名。

我搜了 9 个编排器，没有一个明确实现这个机制。Augment Intent 部分做了，但没作为一等公民暴露给用户。

## 三天里做出了什么

只算实际敲代码的时间，三天，约 4400 行。GitHub: [walterwang0x01/kiro-conduit](https://github.com/walterwang0x01/kiro-conduit)。

| 提交 | 内容 |
|------|------|
| `f151260` | 文档骨架：README + PRD + ARCHITECTURE + ROADMAP |
| `29c5005` | ACP 客户端：异步 Python 客户端，子进程 + JSON-RPC + 流式事件 |
| `59093a4` | CIV 三角色：Coordinator / Implementor / Verifier 端到端跑通 |
| `2ec5f96` | 测试套件：58 个测试，含 mock ACP server，CI 友好 |
| `5c1b271` | 稳定性 runner：5 次端到端 demo 100% 通过，平均 25.2 秒 |

## 踩到的三块暗礁

写代码之前我以为最难的部分是 DAG 调度或者并行控制。**做完了才发现，难的是没人写在文档里的协议细节**。

### 暗礁一：ACP `protocolVersion` 是整数 1，不是日期串

ACP 文档示例里 `protocolVersion` 字段写得像版本号字符串，但 Kiro CLI 实测返回的是整数 `1`。第一次握手 mock server 用了字符串 `"2025-01-01"`——结果初始化失败，没有任何错误信息，进程默默卡住。

解决：用一个一次性的 Python probe 脚本真起 `kiro-cli acp` 子进程发原生 JSON-RPC 抓真实响应，看到字段格式才敢动手。

### 暗礁二：Kiro 会反向请求权限，不响应就永远阻塞

Kiro 写文件、跑命令前会向客户端反向发起 `session/request_permission` JSON-RPC 请求，等客户端回 `{"outcome": {"outcome": "selected", "optionId": "..."}}` 才继续。

我的 M0 客户端最初只 log 了一句 "not implemented" 就忽略——结果第一次跑端到端 demo 时 Kiro **永远阻塞**，直到 600 秒超时。

修法很简单（写自动 `allow_once` 响应器），但坑在于这个机制**任何想做 Kiro 编排器的人都会撞上**，且没有官方文档明确写"客户端必须实现"。

### 暗礁三：`asyncio.create_task` 不存引用会被 GC 回收

为了实现反向请求自动响应，我在收到请求时跑了 `asyncio.create_task(self._send(response))`——把发送动作 fire-and-forget。

[Python 文档明文警告这是错的](https://docs.python.org/3/library/asyncio-task.html#asyncio.create_task)：事件循环只持有 task 的弱引用，GC 可能在 task 完成前回收它。表面看似工作（demo 跑通了），但属于薛定谔 bug——某次 GC 时机一卡，响应没发出，Kiro 就死等。

ruff 的 `RUF006` 规则一眼揪出这个问题。我加了一个 `_spawn_detached` helper：

```python
def _spawn_detached(self, coro):
    task = asyncio.create_task(coro)
    self._detached_tasks.add(task)
    task.add_done_callback(self._detached_tasks.discard)
```

把 task 引用塞进 set，完成时自动清理。这是 Python async 圈子里"该写但常忘写"的经典模板。

## 实测数据

最后一晚跑了 5 次端到端 demo（任务：实现 `calc.add` + 写 pytest 测试 + 通过验证），数据如下：

| 指标 | 实测 | 备注 |
|------|------|------|
| 单元测试 | 49 个 | tests/unit/ |
| 集成测试 | 6 个 | mock ACP server，无需真 Kiro |
| 测试套件总耗时 | 1.93 秒 | CI 友好 |
| 端到端 demo 成功率 | 5 / 5 (100%) | tools/stability_run.py |
| 端到端 demo 耗时 | 19.1s ~ 28.3s（平均 25.2s） | 含 LLM 调用 |
| 端到端 demo 重试次数 | 0 | acceptance 写明 `python3` 后无重试 |
| ruff 错误 | 0 | |
| mypy strict 错误 | 0 | 全 10 个源文件 |

之前一次 demo 出现过 attempts=2 重试——Implementor 用了 `python` 命令，但系统只有 `python3`，static 检查失败，Coordinator 把反馈塞进 prompt 让它重做，第二次过了。

这次重试本身就是 CIV 模式价值的最佳证明：**单 agent 一次性输出错了就错了，CIV 三角色 + 重试机制能自动恢复环境差异类问题**。

## 一些我学到的东西

### 1. 调研一小时省一周

如果我没做那一小时的开源工具调研就开干，最大概率结果是：花两周做一个跟 Conductor / Intent 重叠 80% 的产品，然后发现没人用。

差异化点是花时间找出来的——"没人支持 Kiro" + "没人显式实现接口锁定"——这两条是这个项目存在的全部理由。任何"看起来很酷"的项目立项前都该先问：跟现有的 X 比，我的差异是什么？

### 2. 真实痛点 > 调研出来的痛点

这个项目的需求不是想出来的，是手疼出来的。**我自己写过的"多窗口并行 spec"就是它的 PRD**——每一条手动约定都对应工具里的一个功能。

如果你做开源工具或独立产品，最好的需求来源不是看市场报告，是看自己抽屉里那些"我自己临时写的脚本/约定/checklist"。这些东西每一份都是一个潜在产品。

### 3. 文档先写，代码再写

骨架阶段我没动一行代码，先写了 README + PRD + ARCHITECTURE + ROADMAP，1233 行。这看起来很奢侈，但写完之后所有代码决策都有依据——为什么用 Python？ADR-001 写了。为什么不做自动冲突解决？ARCHITECTURE 里"反例"那节写了。

文档先写最大的好处不是"留档"，是**强迫自己提前回答最难的问题**。等敲到那一行代码时再决定，往往已经被沉没成本绑架。

### 4. mock ACP server 是这一波最值钱的一个文件

集成测试如果真起 `kiro-cli acp` 子进程，每次跑都要登录、消耗 token、走真 LLM。这种测试在 CI 里跑等于自杀。

我写了一个 230 行的 Python 脚本扮演假的 `kiro-cli acp`——读一份 JSON 剧本，按预设回 JSON-RPC 响应。集成测试真的去 spawn 这个子进程，但子进程是我控制的。**1.93 秒跑完 58 个测试，零 token，CI 能用**。

这种"真实进程 + mock 协议"的测试模式在所有需要测协议层的项目里都能复用。

## 接下来

按 ROADMAP，M0 PoC 完成。下一站 M1 MVP——DAG 调度、worktree 池、共享文件锁、接口锁定、TUI dashboard、串行 merge orchestrator。预估 2 周。

如果你也在用 Kiro 处理大型 spec，欢迎试用：

```bash
git clone https://github.com/walterwang0x01/kiro-conduit.git
cd kiro-conduit
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
pytest                                # 跑测试套件，2 秒
python examples/02_civ_hello.py       # 跑端到端 demo，约 25 秒
```

或者只是来 [GitHub repo](https://github.com/walterwang0x01/kiro-conduit) 拍砖也行。这是个 pre-alpha 项目，最需要的是真实使用反馈，最不需要的是 star。

---

> 这是我做 [kiro-conduit](https://github.com/walterwang0x01/kiro-conduit) 系列的第一篇。后面会写：DAG 调度器实现、共享文件锁的几种 policy 选择、接口锁定的契约校验机制、用真实大型 spec 跑 M2 实战的复盘。订阅 [RSS](/rss.xml) 不错过。
