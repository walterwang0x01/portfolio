---
title: "Agent 交互工程：流式、中断、确认、纠错的 UX 实战"
date: 2026-05-18
tags: ["AI Agent", "工程化", "UX"]
excerpt: "Agent 产品的差异不在模型，在交互层。流式 token 与 tool 的混合编排、用户随时打断、高风险操作的人工确认、跑偏时的低成本纠错——这套组合拳决定了用户敢不敢把活交给 Agent。"
emoji: "🎛️"
vip: false
draft: false
---

2026 年 Agent 产品的赛道已经卷到一个尴尬的地步：Cursor、Devin、Manus、ChatGPT Agent 用的底层模型差不多，prompt 也都不是秘密，但用户体验差出一个量级。差距在哪？在交互层。

更具体地说，差在这四件事的工程能力上：**流式（Streaming）、中断（Interrupt）、确认（Approval）、纠错（Correction）**。这四件事单看都不复杂，但凡是把它们当 UI 细节交给前端实习生的团队，产品几乎都翻车了。它们本质是 Agent 控制流的协议设计，必须从后端串到前端一起想。

## Agent UX 不是 UI，是控制协议

传统 Web 后端是请求-响应模型：用户点按钮，后端干活，返回结果。Agent 不是。Agent 是一个**长时间运行、状态在演进、随时可能被中断或修改**的进程。把它装进传统的请求-响应里，体验必然像 ChatGPT 早期版本——发出消息后只能瞪着那个转圈圈。

合格的 Agent 交互至少要支持四类信号在双向流动：

| 方向          | 信号                                | 工程组件                          |
| ------------- | ----------------------------------- | --------------------------------- |
| Agent → 用户  | 文本 token、tool call、tool result、thinking、状态更新 | SSE / WebSocket / 自定义事件流 |
| 用户 → Agent  | 中断、确认/拒绝、文本追加、修改参数 | 控制 channel + 会话状态机         |
| Agent → 工具  | tool 调用、子 agent 委派            | tool runtime + sandbox            |
| 工具 → Agent  | 结果、错误、需要审批的副作用        | tool callback + approval queue    |

把这张表立住，再往下看每一项怎么做。

## 流式：不是一个 token 一个 token 喷出来就完了

最朴素的流式是 SSE 把模型 output 直接转发给前端。但 Agent 场景下输出不是纯文本——夹杂着 tool 调用、tool 结果、thinking blocks、子任务进度。如果只把 text delta 送到前端，用户会看见 Agent 突然"卡住 30 秒"——其实它在跑一个 SQL 查询，但前端不知道。

正确做法是**事件分层流**：

```python
# server.py - FastAPI + SSE
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import json, asyncio

app = FastAPI()

async def agent_event_stream(session_id: str):
    async for event in agent.run_stream(session_id):
        # event.type: text_delta | tool_use | tool_result | thinking | status
        payload = {
            "type": event.type,
            "data": event.data,
            "ts": event.ts,
        }
        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        # 主动 flush，避免 nginx 缓冲
        await asyncio.sleep(0)

@app.get("/agent/stream/{session_id}")
async def stream(session_id: str):
    return StreamingResponse(
        agent_event_stream(session_id),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no"},  # 关掉 nginx 缓冲
    )
```

前端按事件类型渲染不同 UI——text 渐进显示、tool_use 渲染成"正在查询数据库"卡片、tool_result 折叠成可展开块、thinking 用浅色斜体。Claude Code 和 Cursor 都是这套。

实战中还有几个坑：

- **断网重连**要带 `Last-Event-ID`，让服务端从断点续推，避免用户重连后看到一段错位的输出
- **token 节流**：如果模型每秒 80 个 token，前端按真实速度渲染会显得"太快不像在思考"，给前端加一层 16ms tick 的节流反而更自然
- **nginx / CDN 缓冲**：必须设置 `X-Accel-Buffering: no` 或在 ingress 关 buffering，否则数据会被攒到几 KB 才下发，体验比非流式还糟

## 中断：让用户能随时按 Esc

Agent 跑偏了用户最想做的事就是停下来。但很多团队的"中断按钮"其实只是关闭了前端的 SSE 连接——服务端的 LLM 调用仍在烧 token，工具仍在执行 `rm -rf`。这不是中断，这是隐瞒。

正确的中断要做到三层都停：**LLM 推理停、tool 执行停、session 状态可恢复**。

```python
# 用一个 cancellation token 串起整条链
import asyncio
from contextlib import asynccontextmanager

class Session:
    def __init__(self, sid: str):
        self.sid = sid
        self.cancel_event = asyncio.Event()
        self.current_tool_task: asyncio.Task | None = None

    def interrupt(self):
        self.cancel_event.set()
        if self.current_tool_task and not self.current_tool_task.done():
            self.current_tool_task.cancel()

async def run_agent_loop(session: Session, user_msg: str):
    while not session.cancel_event.is_set():
        # LLM 调用要传入 cancel signal
        async for delta in llm.stream(messages, cancel_event=session.cancel_event):
            if session.cancel_event.is_set():
                break
            yield delta

        if needs_tool_call:
            session.current_tool_task = asyncio.create_task(
                run_tool_in_sandbox(tool_call)
            )
            try:
                result = await session.current_tool_task
            except asyncio.CancelledError:
                yield {"type": "interrupted", "stage": "tool"}
                return
```

更高级的实现还应支持 **soft interrupt**（让 Agent 完成当前 tool call 后再停）和 **hard interrupt**（立刻 kill）。Anthropic 的 Computer Use 和 Cursor 的 Agent 都默认 soft，避免文件写一半留下脏数据。

## 确认：高风险操作必须 human-in-the-loop

Agent 想 `rm` 一个目录、转账、发邮件、merge PR——这些必须停下来等用户点确认。这就是 **HITL（Human in the Loop）** 在 Agent 时代的回归。

工程上要解决两个问题：哪些 tool 需要确认，确认期间 session 怎么暂停。一种成熟的做法是给 tool 注册时打 risk 标签，由 runtime 决定走哪条路径：

```python
from enum import Enum

class RiskLevel(Enum):
    SAFE = 0          # 只读，自动执行
    REVERSIBLE = 1    # 可撤销的写操作，根据用户偏好决定
    DESTRUCTIVE = 2   # 不可逆，必须确认

@tool(risk=RiskLevel.DESTRUCTIVE, name="delete_file")
async def delete_file(path: str):
    os.remove(path)

# runtime 拦截
async def execute_tool(call, session):
    tool = registry.get(call.name)
    if tool.risk >= session.user.approval_threshold:
        approval_id = await approval_queue.enqueue(session, call)
        # 发事件给前端，让用户看到一个"是否允许 Agent 执行 X"的 confirm UI
        await session.emit({"type": "approval_request", "id": approval_id, "call": call})
        decision = await approval_queue.wait(approval_id, timeout=600)
        if decision != "approved":
            return {"status": "rejected", "reason": decision}
    return await tool.run(**call.args)
```

落地几个细节：

- **批量确认**：如果 Agent 一次想做 20 个 file edit，让用户挨个点会疯。Cursor 用的是"全部展开 + 一键 Accept All / Reject All / 选择性勾选"
- **超时策略**：用户点完确认离开了，session 不能永远挂着。给 approval 设 10 分钟超时，到点 reject
- **审计日志**：每个 approval 决策（谁、何时、批准/拒绝、理由）写持久化日志，合规和事后排查都靠它

## 纠错：低成本把跑偏的 Agent 拉回来

Agent 跑出预期之外的轨迹时，用户最不想做的是从头来过。设计良好的纠错机制要让用户能"在不重启会话的前提下，廉价地把 Agent 拉回正轨"。

三种主流纠错模式：

| 模式            | 触发方式            | 状态影响                          | 适用场景                      |
| --------------- | ------------------- | --------------------------------- | ----------------------------- |
| 追加修正        | 用户继续打字        | 累积到 history                    | 微调措辞、补充约束            |
| 回退分支（fork）| 编辑历史某条消息    | 从该点截断 history，分叉新对话    | Agent 早期理解错了，整段重来  |
| 直接编辑产物    | 用户改 Agent 输出   | Agent 下一轮以编辑后结果为准      | 代码、文档场景，差不多但要调整 |

ChatGPT 和 Claude 都把"编辑你之前的消息"做成主功能，背后就是 fork。工程上要支持的是**消息树而非消息列表**：

```typescript
interface Message {
  id: string;
  parent_id: string | null;
  role: "user" | "assistant" | "tool";
  content: ContentBlock[];
  created_at: number;
}

interface Session {
  messages: Map<string, Message>;
  // 当前激活的对话路径（叶子节点 id）
  active_leaf: string;
}

// 编辑某条消息 = 创建一条新的 sibling，并把 active_leaf 切到它
function editMessage(session: Session, msgId: string, newContent: ContentBlock[]) {
  const original = session.messages.get(msgId)!;
  const newMsg: Message = {
    id: uuid(),
    parent_id: original.parent_id,
    role: original.role,
    content: newContent,
    created_at: Date.now(),
  };
  session.messages.set(newMsg.id, newMsg);
  session.active_leaf = newMsg.id;  // 后续生成基于新分支
}
```

这套结构还能顺便支持"回到某个状态再试一次"——A/B 对比 Agent 不同回答，对评测和 prompt 调优都很有用。

## 决策矩阵：四件事什么时候必须做

不是所有 Agent 产品都要把这四件事全做满。下面是一个简化的决策表：

| 产品类型              | 流式 | 中断 | 确认 | 纠错 |
| --------------------- | ---- | ---- | ---- | ---- |
| 客服 / Q&A 类         | 必须 | 建议 | 可选 | 建议 |
| Coding Agent          | 必须 | 必须 | 必须 | 必须 |
| 浏览器 / Computer Use | 必须 | 必须 | 必须 | 建议 |
| 数据分析 / BI Agent   | 必须 | 必须 | 建议 | 必须 |
| 内部自动化（无人值守）| 可选 | 必须 | 必须 | 可选 |

Coding 和 Computer Use 两类是"满配"，因为它们干的活儿是真改世界。客服类只要流式做好就能挡住 80% 的体验问题。

## 落地 checklist

接到一个 Agent 产品，按这个清单走一遍能避开大部分坑：

- [ ] SSE/WebSocket 通道支持事件分层，不只是 text delta
- [ ] nginx / CDN / ingress 关闭 buffering，验证首字节延迟 < 500ms
- [ ] 断网重连带 Last-Event-ID，服务端能续推
- [ ] 中断按钮真的取消了 LLM stream 和 tool 执行，不是只关前端连接
- [ ] tool 注册时标 risk level，runtime 按 level 决定是否走 approval
- [ ] approval 有超时和审计日志
- [ ] 用户消息支持编辑，session 用消息树而非列表
- [ ] thinking / tool_use / tool_result 在前端有不同视觉呈现
- [ ] token 渲染加节流（16-30ms tick），避免太快或卡顿
- [ ] 长任务有进度事件，避免"假死 30 秒"

这些都不是 AI 难题，是工程难题。但恰恰是这些工程细节，决定了 2026 年用户愿不愿意每月给你的 Agent 付钱。
