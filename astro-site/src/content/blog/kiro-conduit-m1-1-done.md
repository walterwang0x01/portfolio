---
title: "kiro-conduit M1.1 收官：4 step 把并行编排器从能跑做到能用"
date: 2026-05-29
tags: ["AI Agent", "AI Coding", "工程化", "开源", "并发"]
excerpt: "M1.0 跑通了多任务并行 + 共享文件锁 + 串行 merge，但暴露了一个真问题：两个 task 都追加同一文件的末尾，git 自动 merge 失败。M1.1 用 4 个 step 把这件事和其他几件功能完整度的事一起解决：stub-first 接口锁定从设计上消除冲突、Verifier 加上 AI 语义评审第 3 层、3 种锁 policy 全部实现、rich.live TUI dashboard。本文讲这 4 个设计决策里值得记的工程细节，特别是 Protocol-based pluggable backend 让一个能力优雅地有 4 种使用模式的设计。"
vip: false
draft: false
emoji: "🎯"
---

[上一篇](/posts/kiro-conduit-m1-progress/) 写完 M1.0 端到端跑通：3 个 task 并行、锁正确仲裁、串行 merge——但 demo 末尾 pkg-sub 在 `__init__.py` merge 时撞冲突停下了。我当时说"这是 M1.0 设计契约，但 M1.1 会用 stub-first 从设计上消除"。

这周把 M1.1 的 4 个 step 一口气做完了：

| step | 内容 | 解决的问题 |
|------|------|-----------|
| 1 | Stub-first 接口锁定 | M1.0 那个文本冲突 |
| 2 | Verifier Layer 3（AI 语义 review） | lint/test 抓不到的语义错 |
| 3 | BYOA 模型路由 + 完整锁 policy | 成本控制 + schema 早期承诺的兑现 |
| 4 | TUI dashboard | "我跑了两分钟到底在干啥" |

代码量从 ~3000 涨到 ~4500，单元测试从 102 翻到 193。本文讲这 4 个 step 里值得记的工程细节。

## Step 1：Stub-first 不是"再加一种锁"

我做 stub-first 之前以为它是"在共享文件锁的基础上加一层规则"。实际做完发现**它跟锁是两个完全不同的事**：

| 维度 | 共享文件锁（M1.0） | stub-first 接口锁定（M1.1） |
|------|-------------------|----------------------------|
| 解决的问题 | 写操作的物理冲突 | 设计层面的语义冲突 |
| 生效时机 | 写文件的瞬间 | 整个 task 生命周期 |
| 失败模式 | 锁等不到 → 阻塞 | 偷偷改了 → Verifier 拒 |
| 在哪里实现 | `acquire/release` API | DAG 调度 + AST 比对 |

**单一写者锁防的是"两个 task 同时 write 一个文件"。** 但 M1.0 demo 暴露了：即使串行写，两个 task 都追加同一文件末尾，git merge 时还是会撞——这是**语义冲突**，锁解决不了。

stub-first 的思路是：**不让 consumer 改这个文件**。owner 一次性写好接口 stub，consumer 从 owner 的分支起 worktree，看到的接口已冻结。Verifier Layer 4 用 AST 抽签名做 diff，consumer 偷偷改了直接拒。

实测拦下了什么？M1.1 step 1 的 demo 跑起来时，Kiro 本能想去改 `__init__.py`（即使 spec 写了"不要改"）。pkg-mul 第一次 attempt 加了 import，Verifier Layer 4 抓到签名漂移，反馈给 Implementor 重做。第二次只改自己的实现文件，过了。

**这个故事的关键不是"LLM 听话了"，而是"我们不需要它听话"。** 契约校验是个独立的真理来源，不依赖 prompt。

## Step 2：Layer 3 用 Protocol，让一个能力有 4 种使用模式

Verifier 的第 3 层（AI 语义评审）我犹豫过实现方式：

| 方案 | 优点 | 缺点 |
|------|------|------|
| 起独立 Kiro CLI 子进程跑 review prompt | 跟现有架构一致 | 慢，耗 token |
| 直接调 OpenAI/Anthropic SDK | 快，token 精确 | 引入新依赖 |
| 复用 Implementor 的 ACP 客户端 | 0 新组件 | "自己审自己" |

最后我选了 **Protocol-based pluggable backend**——不在这三个里选，而是让用户选。

```python
class SemanticReviewer(Protocol):
    async def review(self, ctx: ReviewContext) -> ReviewResult: ...
```

实现两个：
- `NoOpSemanticReviewer`：永远 PASS。默认。
- `KiroSemanticReviewer`：spawn 独立 Kiro CLI 子进程跑 review prompt。

用户想用 OpenAI API 直接审？自己写一个实现 `review` 方法的类就行——Python `Protocol` 是 structural typing，不需要继承基类。

这个设计意外地让一个能力变出了 4 种使用模式：

```python
# 1. 默认：什么都不做，零成本
verifier = Verifier()

# 2. 测试 / dev：跑了但永远 PASS
verifier = Verifier(semantic_reviewer=NoOpSemanticReviewer())

# 3. 生产：起独立 Kiro 跑评审
verifier = Verifier(semantic_reviewer=KiroSemanticReviewer())

# 4. 自定义：用户自己接 OpenAI / Claude
class MyOpenAIReviewer:
    async def review(self, ctx): ...
verifier = Verifier(semantic_reviewer=MyOpenAIReviewer())
```

**Protocol > ABC**：在做内部组件抽象时，Python `Protocol` 几乎总是更好的选择——零样板、零继承负担、structural typing 让"实现"这件事自然发生。

### 还有 fail-open 哲学

ARCHITECTURE.md 里我写过 "verifier 挂了不能阻塞业务"。M1.1 step 2 在三个地方落地：

1. KiroSemanticReviewer 子进程崩 → fail-open PASS
2. `run_with_timeout` 等待超时 → fail-open PASS
3. `parse_review_response` 找不到 PASS/FAIL 关键字 → fail-open PASS

但 reviewer 自己说 fail（结构化输出）→ **真 fail**，propagate。区别清晰。

## Step 3：取消 schema 里的早期承诺

M1.0 时 dag.py schema 里就声明过 3 种锁 policy（`single-writer` / `append-only` / `coordinator-only`），但只实现了第一种——其他两种 parse 时直接拒：

```python
if policy != SharedFilePolicy.SINGLE_WRITER:
    raise DagError(
        f"shared_files[{idx}].policy={policy.value!r} not supported in M1.0; "
        "only 'single-writer' is implemented"
    )
```

这种"schema 承诺了未来能力"是个有意识的设计选择——让早期用户写 dag.yaml 时就用对的语法，未来升级零迁移成本。M1.1 step 3 把这个承诺兑现：

- **append-only**：退出 context 时校验 file 内容必须以旧内容为前缀（实现层仍互斥防 write 交错）
- **coordinator-only**：task acquire 直接抛 LockError——只有 Coordinator 自己（不通过 acquire）才能改

实现都很短，关键在于**早期 schema 设计的 3 个 policy 字符串没改一个**。

### BYOA 路由的小惊喜

`kiro-cli acp` 实测原生支持 `--model` flag——我以为要走 `session/set_model` 协议消息，结果直接命令行就行。spawn 时多 `["--model", "claude-opus-4.7"]` 两个参数搞定。

```python
# 用户配一个 dict 就行
ParallelOrchestrator(
    workspace=ws,
    base_repo=repo,
    model_routing={"implementor": "claude-sonnet-4.7"},
    semantic_reviewer=KiroSemanticReviewer(model="claude-opus-4.7"),
)
```

Implementor 用便宜模型（量大），reviewer 用强模型（精度），各取所需。

## Step 4：TUI dashboard 选 rich 不选 textual

我做 dashboard 时纠结过用哪个：

| 维度 | rich | textual |
|------|------|---------|
| 学习曲线 | 低 | 高 |
| 实时刷新 | `Live(...)` 一行 | 写完整 App + reactive |
| 交互 | 无 | 完整 keyboard/mouse |
| 重量 | 轻（纯渲染） | 重（事件循环 + widget tree） |

**dashboard 是 monitor，不是 IDE**——只看不点。rich 完全够。

但我没把"打印事件"塞进 orchestrator——那会让两个组件强绑定。我加了一个轻量的 EventBus：

```python
@dataclass(frozen=True)
class WaveStarted: ...
@dataclass(frozen=True)
class TaskStarted: ...
# ... 6 种事件

class EventBus:
    def subscribe(self, callback) -> Callable[[], None]: ...
    def publish(self, event) -> None: ...
```

Orchestrator / Locks / Merge 在关键路径 publish。Dashboard 订阅，按收到的事件更新内存状态，rich Live 自动重绘。两边没有任何相互依赖：

```python
# 不开 dashboard：行为完全跟 M1.0 一样
orchestrator = ParallelOrchestrator(workspace=ws, base_repo=repo)

# 开 dashboard：给个 bus，挂 dashboard
bus = EventBus()
orchestrator = ParallelOrchestrator(workspace=ws, base_repo=repo, event_bus=bus)
dashboard = Dashboard(workspace=ws)
dashboard.attach(bus)
with dashboard.live():
    await orchestrator.run()
```

EventBus 还有一个隐藏好处：**dashboard 测试不用 mock 整个 orchestrator**。我直接 publish 事件给 dashboard 的 EventBus，断言它的内存状态变了。9 个 dashboard 测试加 13 个 EventBus 测试，1 秒跑完。

## 数据：M0 → M1.0 → M1.1

| 维度 | M0 | M1.0 | M1.1 |
|------|----|------|------|
| 源代码行数 | ~1100 | ~3000 | **~4500** |
| 单元测试 | 49 | 102 | **193** |
| 源文件 | 10 | 15 | **19** |
| 第三方依赖 | 0 | PyYAML | **+ rich** |
| 锁 policy | — | 1 种 | **3 种** |
| Verifier 层 | 2 | 2 | **4** |
| TUI | — | — | **✅** |
| BYOA 路由 | — | — | **✅** |
| ruff / mypy strict | clean | clean | clean |

代码量翻 4 倍，测试翻 4 倍，能力维度从 M1.0 的"能跑"扩到 M1.1 的"能用"。

## 几条小教训

### 1. 早期 schema 留位置比晚期改 schema 便宜

M1.0 schema 就支持 `policy: append-only`，只是实现没跟上。M1.1 step 3 时**用户写过的 dag.yaml 一个字不用改**——只是 parse 不再拒。如果 M1.0 schema 只允许 single-writer，M1.1 时就要做向后兼容的字符串映射，丑得多。

### 2. `Protocol` 是内部组件抽象的最佳工具

`SemanticReviewer` 的 4 种使用模式（默认 / no-op / Kiro / 自定义）在传统 OOP 下要么是 4 个继承类、要么是工厂模式 + 配置文件。Protocol 让用户实现接口的成本接近零。

### 3. 不要把"打印事件"塞进核心组件

我最初想把 dashboard 的状态更新写成 orchestrator 的 callback——一个 `on_task_started=...` 参数。这意味着每加一个事件就改一个 orchestrator 签名。EventBus 让所有事件类型都从签名里消失，新事件就是新 dataclass，订阅者自己分流。

### 4. Fail-open 哲学要写进文档

ARCHITECTURE.md 里那句"verifier 挂了不能阻塞业务"在 M1.1 step 2 真用上了——超时、子进程崩、解析失败都默认 PASS。但要让团队（甚至未来的自己）一致执行这个原则，文档里写一遍是值得的。

## 下一步：M2 实战

M1.1 完成的能力够撑 **M2 实战**——拿真实项目的大 spec（跨多模块 + 跨两仓库的 11 PR 项目）跑一次，验证 M1.1 在真实负载下不崩。

按 ROADMAP，M2 主要是：
- 真实项目的 dag.yaml 接入
- 跨仓库支持（M1.1 现在还是单 repo）
- 性能 / 内存基准
- 故障场景演练

预计 1 周，下一篇博客见。

## 仓库

- 代码：[github.com/walterwang0x01/kiro-conduit](https://github.com/walterwang0x01/kiro-conduit)
- 上一篇：[M1.0 进展](/posts/kiro-conduit-m1-progress/)
- 起源：[kiro-conduit 起源故事](/posts/kiro-conduit-origin-story/)

最快上手：

```bash
git clone https://github.com/walterwang0x01/kiro-conduit.git
cd kiro-conduit
python3 -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
pytest                                                # 199 测试，~6 秒
KIRO_CONDUIT_DASHBOARD=1 \
  python examples/04_m1_stub_first_demo.py            # M1.1 完整 demo（含 TUI）
```
