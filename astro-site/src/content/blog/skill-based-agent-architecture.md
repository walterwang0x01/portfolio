---
title: "Skill-based Agent 架构：从 Tool Use 到可组合能力的范式迁移"
date: 2026-05-09
tags: ["Claude Skills", "Agent 架构", "AI Agent"]
excerpt: "2025 年末 Anthropic 推出 Claude Skills，把 Agent 能力从零散的 tool 调用推向了 SKILL.md + 渐进式加载的可组合模式。本文拆解 Skill 与 Tool、MCP、Subagent 的边界，给出一套能在生产落地的 Skill 架构骨架。"
vip: false
draft: false
emoji: "🧩"
---

过去两年做 Agent，绕不开的一个词是 tool。给 LLM 塞一堆函数 schema，让它自己决定调谁。这套范式把 Agent 从 demo 推到了生产，但也把 prompt 塞成了火车头——一个稍微正经点的 Agent 动辄 20 个工具、5k tokens 的 system prompt，启动就烧钱，还经常选错工具。

2025 年 10 月，Anthropic 正式发布 [Claude Skills](https://www.anthropic.com/news/skills)，把这套范式往前推了一步：能力不再是扁平的 tool 列表，而是一个个可组合、可发现、按需加载的 Skill 包。OpenAI 的 Agent Builder、Google 的 ADK 随后也给出了相似形态。

这不是换个名字的 tool use，而是 Agent 架构层面的一次分层重构。本文拆解 Skill 的设计哲学、和既有组件的边界，以及在自己的 Agent 系统里怎么落地。

## 为什么 Tool Use 撑不住了

先看一个真实项目的痛点。我们给客服 Agent 接了 18 个工具，覆盖订单、退款、客户信息、VIP 等级、优惠券、物流、投诉工单七个域。跑了两个月后复盘：

- system prompt 总长 8.2k tokens，每次请求起步就 0.08 刀
- 工具描述写得越详细，Claude 越爱过度调用（明明用户只是打招呼，也会先查一遍客户信息）
- 新增一个域的功能，要在 18 个工具之间权衡描述长度，改一个影响全部
- 权限控制只能在 server 端兜底，LLM 根本不知道某些工具该在什么场景用

问题的根子是：**工具是原子操作，但 Agent 的能力单位其实是「场景 + 知识 + 工具组合」**。把这三样强行打散成平铺的 tool，就会出现上面的副作用。

Skill 要解决的就是这层抽象缺失。

## Skill 的三个核心要素

Anthropic 对 Skill 的定义很克制：**一个文件夹，里头放 SKILL.md 加可选的脚本和资源**。简单到容易被低估。真正关键的是它背后的三个约束：

1. **渐进式披露（Progressive Disclosure）**：默认只加载 SKILL.md 的 frontmatter（几十 tokens），Claude 觉得相关才读完整内容，再相关才加载子文件
2. **model-invoked**：skill 的触发完全交给模型推理，没有硬编码路由
3. **可组合**：多个 skill 可以串联，Claude 自己决定调用顺序和参数传递

一个典型的 SKILL.md 长这样：

```markdown
---
name: refund-processing
description: |
  处理 Agenzo 订单退款。当用户提到"退款""取消订单""不想要了"时使用。
  支持打车订单和商品订单，会自动判断是否已过退款时效。
---

# 退款处理

## 流程

1. 调用 `get_order_detail` 确认订单状态
2. 用 `check_refund_eligibility` 校验时效（见 `rules.md`）
3. 调用 `initiate_refund` 发起退款
4. 用 i18n 模板回复用户（见 `templates/`）

## 细节

详细退款规则见 [rules.md](./rules.md)。
退款话术模板见 [templates/](./templates/)。
```

frontmatter 里的 `name` + `description` 是 Claude 唯一默认看到的内容。只有当上下文里出现退款意图，它才会去读正文；只有需要具体时效规则，才会打开 `rules.md`。

这套设计等价于把 system prompt 做了 lazy loading。

## 从 Tool 到 Skill：同一个需求的两种写法

把 Agenzo 里一个真实场景——「预约机场接送」——用两种范式实现一下，差异会很清楚。

### Tool Use 写法

```python
# 传统 tool 方式：能力全部展开在 system prompt
AIRPORT_TOOLS = [
    {
        "name": "get_airport_quote",
        "description": "获取机场接送报价。参数包括出发机场代码、目的地地址、接送时间、车型。用户提到'机场'或'接机'时使用...",
        "input_schema": {...}
    },
    {
        "name": "check_flight_status",
        "description": "查询航班状态，用于预约接机时确认到达时间...",
        "input_schema": {...}
    },
    {
        "name": "book_airport_ride",
        "description": "创建机场预约订单。必须先获取报价,并完成支付预授权...",
        "input_schema": {...}
    },
    # ... 还有 5 个相关 tool
]

# 另外 50 行 prompt 讲清楚「机场接送有 3 小时接机保障」这类业务规则
# 还得说明非机场场景不要用这套 tool
```

18 个域每个都这么写，context 就爆了。

### Skill 写法

```
agenzo-skills/
├── airport-transfer/
│   ├── SKILL.md              # 场景入口,70 tokens
│   ├── flight-rules.md       # 接机保障规则,按需加载
│   ├── scripts/
│   │   └── flight_lookup.py  # 航班查询脚本
│   └── templates/
│       ├── confirmation.zh.md
│       └── confirmation.en.md
├── city-ride/
│   └── SKILL.md
└── refund-processing/
    └── SKILL.md
```

SKILL.md 自己就是执行手册，脚本是真正的操作层。tool 数量从 18 降到每个 skill 3-5 个原子操作，system prompt 只留 skill 索引。

## 工程落地：最小可用的 Skill 框架

如果用的不是 Claude，或者想自己实现 skill 语义（有一说一 Anthropic 的能力目前还没完全开源化），可以用下面这套最小框架跑起来。核心是两件事：skill 注册中心 + 渐进加载器。

```python
# skill_registry.py
from dataclasses import dataclass
from pathlib import Path
import yaml


@dataclass
class SkillMeta:
    name: str
    description: str
    path: Path
    tools: list[str]


class SkillRegistry:
    """扫描 skills/ 目录,只读 frontmatter 做索引"""

    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self._index: dict[str, SkillMeta] = {}
        self._load_index()

    def _load_index(self):
        for skill_md in self.skills_dir.glob("*/SKILL.md"):
            content = skill_md.read_text(encoding="utf-8")
            # 只解析 frontmatter,不读正文
            if not content.startswith("---"):
                continue
            _, fm, _ = content.split("---", 2)
            meta = yaml.safe_load(fm)
            self._index[meta["name"]] = SkillMeta(
                name=meta["name"],
                description=meta["description"],
                path=skill_md.parent,
                tools=meta.get("tools", []),
            )

    def catalog(self) -> str:
        """给 Agent 的 system prompt 注入的轻量目录"""
        lines = ["<available_skills>"]
        for m in self._index.values():
            lines.append(f"- {m.name}: {m.description.splitlines()[0]}")
        lines.append("</available_skills>")
        return "\n".join(lines)

    def load_skill(self, name: str) -> str:
        """Agent 决定用某个 skill 时,懒加载完整内容"""
        meta = self._index[name]
        return (meta.path / "SKILL.md").read_text(encoding="utf-8")
```

Agent 主循环里，system prompt 只有 catalog，真正执行时才 load：

```python
# agent_loop.py
async def run_agent(user_msg: str, registry: SkillRegistry):
    messages = [
        {"role": "system", "content": f"你是助手。\n{registry.catalog()}"},
        {"role": "user", "content": user_msg},
    ]

    # 第一轮:Claude 决定要不要加载某个 skill
    resp = await llm.chat(messages, tools=[LOAD_SKILL_TOOL])

    if resp.tool_calls and resp.tool_calls[0].name == "load_skill":
        skill_name = resp.tool_calls[0].arguments["name"]
        messages.append({"role": "assistant", "content": resp.content, "tool_calls": resp.tool_calls})
        messages.append({
            "role": "tool",
            "tool_call_id": resp.tool_calls[0].id,
            "content": registry.load_skill(skill_name),
        })
        # 第二轮:skill 内容已注入,继续执行
        resp = await llm.chat(messages, tools=registry.tools_for(skill_name))

    return resp
```

这个实现不到 100 行，但拿到的收益是真金白银的：system prompt 从 8k 降到 300 tokens，Prompt Cache 命中率也从 30% 飙到 85%。

## Skill 到底和什么不一样

这是最多人搞混的地方。我把四种能力单位放一起对比：

| 维度 | Tool | MCP Server | Subagent | Skill |
|---|---|---|---|---|
| **粒度** | 单个函数 | 一组函数+资源 | 完整 Agent | 场景+知识+工具 |
| **加载时机** | 全量进 prompt | 连接即可见 | 调用时启动 | 按需披露 |
| **知识载体** | schema 描述 | server 说明 | 独立 prompt | SKILL.md |
| **调用者** | LLM | LLM | 主 Agent | LLM |
| **复用单位** | 函数复用 | 服务复用 | Agent 复用 | 能力包复用 |
| **典型大小** | 50-200 tokens | 500-2k tokens | 独立 context | 100-500 tokens 索引 |
| **关键优势** | 精细控制 | 标准协议 | 独立上下文 | 组合 + 懒加载 |
| **关键局限** | context 膨胀 | 运行时依赖 | 调度复杂 | 标准仍在演进 |

它们不是替代关系。真实生产中我会这么组合：

- **MCP Server** 提供底层能力（数据库、API 网关）
- **Tool** 是 MCP 暴露的原子函数
- **Skill** 组装 tool + 业务知识成为场景能力
- **Subagent** 处理需要独立 context 的子任务（如长文档分析）

## 两个最容易踩的坑

**坑 1：Skill 粒度。** 新手最常见的错误是把 skill 写成 tool 的同义词（一个 skill 只封装一个函数），或者写成域（一个 skill 塞下整个「订单系统」）。经验值：一个 skill 对应一个用户可感知的场景，包含 3-8 个 tool，SKILL.md 完整展开在 500-1500 tokens 之间。

**坑 2：Skill 之间的依赖。** SKILL.md 里写 "先调用 refund-processing 再调用 notification" 是反模式——这把编排逻辑硬编码进了 skill。正确做法是把共享能力下沉成独立 skill（或底层 tool），让主 Agent 去编排。

另一个隐形陷阱是版本管理。Skill 是代码的一部分，但 SKILL.md 的改动会直接影响线上行为。一定要把 skill 纳入 CI：加回归测试用例，改 description 就要跑一遍端到端评测。

## 什么时候别用 Skill

Skill 不是银弹。以下场景继续用 Tool/MCP 更合适：

- 能力少于 5 个，拆 skill 反而过度设计
- 调用路径非常确定（如 fixed workflow），不需要 LLM 自主决策
- 延迟敏感场景，skill 的二次加载会多一轮 LLM 调用
- 需要审计和权限编码到代码里，而不是靠 LLM 自律

## 落地 checklist

准备在自己项目里引入 skill 架构时，可以按这个清单走：

- [ ] 梳理现有 tool，按「用户场景」聚类，能聚出 5 个以上再考虑引入 skill
- [ ] 第一批 skill 选 3 个高频场景试点，不要一次全量迁移
- [ ] SKILL.md 的 description 只写"什么场景用它"，不写"怎么用"，后者在正文
- [ ] 每个 skill 配套至少 5 条端到端测试用例
- [ ] 在 CI 里对比新旧版本的 token 消耗与工具选错率
- [ ] 如果用非 Claude 模型，提前验证它对 skill 索引+懒加载模式的执行稳定度
- [ ] 监控 skill 加载命中率，小于 30% 的 skill 要么重写 description，要么下线

Tool use 解决了 Agent 会不会用工具的问题，Skill 解决的是 Agent 知不知道什么时候该用什么能力的问题。2026 年做生产级 Agent，这层抽象基本上是必修课。
