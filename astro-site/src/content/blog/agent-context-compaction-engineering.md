---
title: "Agent 上下文压缩生产实战：长任务不掉线、账单不翻倍的五级策略"
date: 2026-07-09
tags: ["AI Agent", "Context Engineering", "工程化"]
excerpt: "长任务 Agent 的上下文会在 20 轮后撑爆窗口、拖垮缓存、烧光预算。本文拆解五级压缩策略、触发器设计与 Cache 友好实现，附 Python/TypeScript 可运行代码与落地 checklist。"
emoji: "🗜️"
vip: false
draft: false
---

一个 Coding Agent 修复中等复杂度 bug，平均要走 15-25 轮工具调用。每轮往上下文里追加 3k-8k tokens 的工具返回值，到第 18 轮时上下文已经 120k+——还没算 system prompt 和工具定义。此时你会同时撞上三堵墙：**窗口溢出**、**Prompt Cache 断裂**、**单次任务成本翻倍**。

Context Engineering 指南里把「Compress」列为四大策略之一，但生产落地时，压缩不是调一个 `max_tokens` 就完事。你需要回答：什么时候压？压哪一层？压完模型还记不记得关键决策？压了之后缓存前缀还能不能命中？

这篇文章给出一套可落地的 **五级压缩架构**，从「清工具结果」到「全量摘要」，并重点解决 2026 年 Agent 团队最容易忽略的 **Cache 友好压缩** 问题。

## 为什么压缩是独立工程问题

压缩和 Token 预算管理、RAG 截断不是一回事：

| 维度 | Token 预算管理 | RAG 截断 | 上下文压缩 |
|------|---------------|---------|-----------|
| 触发时机 | 每步检查余额 | 检索阶段 | 多轮累积后 |
| 作用对象 | 整次执行 | 外部知识 | 对话历史 + 工具结果 |
| 核心目标 | 防止跑飞 | 控制噪声 | 保留决策、丢细节 |
| 副作用 | 可能提前终止 | 可能漏信息 | 可能丢关键上下文 |

> 压缩的本质是信息密度管理：用更少的 token 表达同样的「任务状态」，而不是简单删消息。

Claude Code 源码暴露了一个真实教训：自动压缩 bug 导致全球每天浪费约 25 万次 API 调用——修复方法只是加 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`。这说明压缩链路必须有**熔断和可观测性**，不能 silent fail。

## 五级压缩策略

从轻到重，每一级都有明确的适用场景和不可逆代价：

| 级别 | 名称 | 压缩对象 | 信息损失 | 典型节省 | 适用场景 |
|------|------|---------|---------|---------|---------|
| L1 | Microcompact | 旧 tool_result 正文 | 低 | 40-60% | 每 5-10 步自动触发 |
| L2 | Tool Summary | 大块工具输出 | 中低 | 50-70% | 日志/搜索结果/文件内容 |
| L3 | Turn Collapse | 连续对话轮次 | 中 | 60-80% | 探索性多轮后收敛 |
| L4 | Full Compact | 全量历史摘要 | 高 | 80-90% | 用户主动 / 窗口临界 |
| L5 | PTL Truncate | 最早消息组 | 极高 | 90%+ | 最后手段，可能丢目标 |

**选型原则**：永远在能解决问题的最低级别停手。L4/L5 会显著增加「模型遗忘原始约束」的风险，触发前应先尝试 L1-L3。

## L1 Microcompact：保留决策，丢弃过程

L1 只处理**已完成的工具调用结果**，把「搜索了 47 个文件、读取了 12 个模块」压缩成一句结论，原始数据外化到 scratchpad。

```python
from dataclasses import dataclass
from datetime import datetime, timedelta
import json


@dataclass
class ToolResult:
    tool_use_id: str
    tool_name: str
    content: str
    created_at: datetime
    is_write_op: bool = False  # 写操作结果不自动压缩


class Microcompactor:
  """L1: 基于时间窗口压缩旧 tool_result，保留最近 N 轮完整内容"""

  def __init__(self, keep_recent: int = 3, max_age_sec: float = 300):
    self.keep_recent = keep_recent
    self.max_age_sec = max_age_sec

  def compact_messages(self, messages: list[dict]) -> list[dict]:
    tool_results = [
      (i, m) for i, m in enumerate(messages)
      if m.get("role") == "user" and _is_tool_result_block(m)
    ]
    if len(tool_results) <= self.keep_recent:
      return messages

    cutoff = datetime.now() - timedelta(seconds=self.max_age_sec)
    result = list(messages)

    for idx, (msg_idx, msg) in enumerate(tool_results[:-self.keep_recent]):
      block = msg["content"][0]
      if block.get("is_write_op"):
        continue
      created = block.get("created_at", datetime.now())
      if created > cutoff:
        continue
      original_len = len(block["content"])
      block["content"] = self._summarize(block["tool_name"], block["content"])
      block["compacted"] = True
      block["original_tokens"] = original_len // 4  # 粗估
    return result

  def _summarize(self, tool_name: str, content: str) -> str:
    # 生产环境用 Haiku 做摘要；这里演示规则版
    if tool_name == "grep":
      lines = content.strip().split("\n")
      return f"[已搜索，{len(lines)} 处匹配，详见 scratchpad:grep_{hash(content) % 10000}]"
    if len(content) > 500:
      return f"[{tool_name} 返回 {len(content)} 字符，摘要: {content[:200]}...]"
    return content


def _is_tool_result_block(msg: dict) -> bool:
  content = msg.get("content", [])
  return isinstance(content, list) and content and content[0].get("type") == "tool_result"
```

关键设计：**写操作结果（create_file、run_sql）永不自动 L1 压缩**，避免模型以为操作未执行而重复写入。

## L2-L3：结构化摘要而非自由发挥

L2/L3 需要 LLM 做摘要时，不要用开放式 prompt——结构化输出能显著降低「摘要丢关键信息」的概率：

```python
SUMMARIZE_SCHEMA = {
  "type": "object",
  "properties": {
    "task_goal": {"type": "string", "description": "用户原始目标，一字不改复述"},
    "completed_steps": {"type": "array", "items": {"type": "string"}},
    "key_findings": {"type": "array", "items": {"type": "string"}},
    "open_issues": {"type": "array", "items": {"type": "string"}},
    "file_refs": {
      "type": "array",
      "items": {"type": "object", "properties": {
        "path": {"type": "string"},
        "relevance": {"type": "string"}
      }}
    },
    "discarded": {"type": "string", "description": "被丢弃的探索过程，一句话"}
  },
  "required": ["task_goal", "completed_steps", "key_findings", "open_issues"]
}


async def structured_compact(client, messages: list[dict], level: str) -> dict:
  resp = await client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=2000,
    messages=[{
      "role": "user",
      "content": f"将以下 Agent 对话压缩为结构化摘要（级别 {level}）。"
                 f"必须保留 task_goal 和所有未解决的 open_issues。\n\n"
                 f"{json.dumps(messages, ensure_ascii=False)}"
    }],
    tools=[{
      "name": "emit_summary",
      "description": "输出结构化摘要",
      "input_schema": SUMMARIZE_SCHEMA
    }],
    tool_choice={"type": "tool", "name": "emit_summary"},
  )
  tool_block = next(b for b in resp.content if b.type == "tool_use")
  return tool_block.input
```

摘要用 **Haiku 级别小模型** 做，成本是 Sonnet 的 1/5，且摘要任务不需要强推理能力。

## Cache 友好压缩：skip 而非 delete

这是 2026 年最容易被忽略的坑。传统做法是直接 `messages = messages[-20:]`，但这会**改变发送给 API 的完整前缀**，导致 Prompt Cache 从断点处全部失效——下一次请求 input 成本瞬间 ×10。

Claude Code 的做法是 **cache_edits：标记旧消息为 skip**，API 侧不再计入上下文，但字节流前缀保持连续：

```typescript
type MessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: string; skip?: boolean };

interface CompactionEdit {
  kind: "skip_range" | "replace_with_summary";
  fromIndex: number;
  toIndex: number;
  summary?: string;
}

class CacheAwareCompactor {
  private edits: CompactionEdit[] = [];

  /** 生成带 skip 标记的消息副本，不修改原始数组 */
  applySkips(messages: MessageBlock[]): MessageBlock[] {
    const skipped = new Set<number>();
    for (const edit of this.edits) {
      if (edit.kind === "skip_range") {
        for (let i = edit.fromIndex; i <= edit.toIndex; i++) skipped.add(i);
      }
    }
    return messages.map((msg, i) =>
      skipped.has(i) ? { ...msg, skip: true } : msg
    );
  }

  microcompact(toolResultIndices: number[], keepRecent: number): void {
    const toSkip = toolResultIndices.slice(0, -keepRecent);
    if (toSkip.length === 0) return;
    this.edits.push({
      kind: "skip_range",
      fromIndex: toSkip[0],
      toIndex: toSkip[toSkip.length - 1],
    });
  }

  /** 监控：skip 后缓存命中率是否维持 */
  cacheHealthMetrics(hitRate: number, preSkipHitRate: number): string {
    if (hitRate < preSkipHitRate * 0.8) {
      return "WARN: skip 导致缓存命中率下降 >20%，检查前缀是否被意外修改";
    }
    return "OK";
  }
}
```

实践建议：**system prompt + 工具定义 + 前 3 轮对话** 作为「不可变前缀」，所有压缩操作只作用于前缀之后的区域。

## 触发器设计：何时压缩

盲目每 5 轮压缩一次会打断模型推理链。推荐多信号联合触发：

```python
from enum import Enum


class CompactTrigger(Enum):
  NONE = "none"
  L1_MICRO = "l1_micro"
  L2_TOOL = "l2_tool"
  L3_TURN = "l3_turn"
  L4_FULL = "l4_full"


class CompactionPolicy:
  def __init__(
    self,
    window_limit: int = 180_000,      # 模型窗口 200k，留 20k 余量
    soft_threshold: float = 0.70,     # 70% 触发 L1
    hard_threshold: float = 0.85,     # 85% 触发 L3
    critical_threshold: float = 0.95, # 95% 触发 L4
  ):
    self.window_limit = window_limit
    self.soft_threshold = soft_threshold
    self.hard_threshold = hard_threshold
    self.critical_threshold = critical_threshold

  def evaluate(self, current_tokens: int, steps: int, last_compact_step: int) -> CompactTrigger:
    utilization = current_tokens / self.window_limit

    if utilization >= self.critical_threshold:
      return CompactTrigger.L4_FULL
    if utilization >= self.hard_threshold:
      return CompactTrigger.L3_TURN
    if utilization >= self.soft_threshold and steps - last_compact_step >= 5:
      return CompactTrigger.L1_MICRO
    # 工具结果占比过高时提前 L2
    if self._tool_results_ratio(current_tokens) > 0.6 and steps >= 8:
      return CompactTrigger.L2_TOOL
    return CompactTrigger.NONE

  def _tool_results_ratio(self, _: int) -> float:
    # 实际实现中统计 messages 里 tool_result token 占比
    return 0.0  # placeholder
```

额外规则：

- **用户发送新消息时**：先 L1，给用户响应腾出空间
- **工具返回 > 10k tokens 时**：立即 L2，不等阈值
- **压缩后仍超 90%**：熔断，返回「上下文已满，请开新会话」而非 silent truncate

## 压缩质量怎么验

压缩上线后最大的风险是**静默退化**——模型不再记得 10 轮前用户说的约束。用三类信号监控：

| 信号 | 检测方式 | 告警阈值 |
|------|---------|---------|
| 任务完成率 | 压缩前后同任务集 pass@1 | 下降 > 5% |
| 重复工具调用 | 同一 tool+args 30s 内重复 | > 2 次/任务 |
| 约束违背率 | LLM-as-judge 检查是否违反 task_goal | > 8% |

```python
async def compaction_regression_suite(agent_fn, tasks: list[str]) -> dict:
  baseline = [await agent_fn(t, compact=False) for t in tasks]
  compacted = [await agent_fn(t, compact=True) for t in tasks]
  pass_rate_base = sum(1 for r in baseline if r.success) / len(tasks)
  pass_rate_compact = sum(1 for r in compacted if r.success) / len(tasks)
  return {
    "baseline_pass_rate": pass_rate_base,
    "compact_pass_rate": pass_rate_compact,
    "delta": pass_rate_compact - pass_rate_base,
    "alert": pass_rate_compact < pass_rate_base - 0.05,
  }
```

每次调整压缩策略或摘要 prompt，跑一遍回归套件再上线。

## 落地 Checklist

上线前逐项确认：

- [ ] 五级策略已实现，默认只自动触发 L1-L2
- [ ] 写操作 tool_result 在 L1 中豁免
- [ ] 压缩使用 skip/cache_edits，而非截断前缀
- [ ] 大块工具输出外化到 scratchpad，摘要里保留引用 ID
- [ ] L3+ 摘要使用结构化 schema，小模型执行
- [ ] 多信号触发器（利用率 + 步数 + 工具占比）已接入
- [ ] 连续压缩失败 ≥3 次触发熔断，避免无限重试
- [ ] 监控：缓存命中率、压缩后 token 数、任务完成率 delta
- [ ] 压缩事件写入 trace（Langfuse/LangSmith），可回放对比

## 选型建议

| 你的场景 | 推荐策略 |
|---------|---------|
| 短对话客服 Agent（< 8 轮） | 只做工具结果截断，不需要分级压缩 |
| Coding / 研究类长任务 | L1 自动 + L3 阈值触发 + scratchpad 外化 |
| 多 Agent 协作 | 各 Agent 独立压缩，共享状态走 KV 而非共享 messages |
| 成本敏感 | L1 skip 保持 cache + Haiku 做 L3 摘要 |
| 高可靠性（金融/医疗） | 禁用 L5；L4 需用户确认后再执行 |

上下文压缩不是「省钱技巧」，而是长任务 Agent 的**状态管理基础设施**。把压缩当成和 checkpoint、错误恢复同等级别的工程模块来建设——你的 Agent 才能在 30 轮、50 轮之后仍然记得用户最初要什么。
