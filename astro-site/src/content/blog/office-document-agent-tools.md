---
title: "办公文档 Agent 工具：Word / Excel / PPT 的 Tool 设计实战"
date: 2026-07-07
tags: ["AI Agent", "Function Calling", "工程化"]
excerpt: "Agent 能写代码却改不了同事的 .docx？OfficeCLI 等工具把办公文档操作拉进 tool 层。本文拆解文档类 Tool 的 Schema 设计、格式陷阱与生产落地 checklist。"
emoji: "📄"
vip: false
draft: false
---

Coding Agent 能重构整个代码库，却在面对「帮我把这份 Word 里的表格改成三线表」时束手无策——不是因为 LLM 不会，而是因为**工具层没有稳定、可组合的文档操作原语**。2026 年 7 月，开源项目 OfficeCLI 在 Hacker News 获得 126 赞，正是填这个空白：让 Agent 通过 CLI 读写编辑 Word、Excel、PPT。

办公文档场景的企业需求极其普遍：法务审合同、财务改报表、市场调 PPT 模板。把这类能力纳入 Agent，价值远高于再写一个 Todo MCP。难点在于**二进制格式复杂、版式语义模糊、协作冲突难处理**。本文从工程视角梳理文档 Tool 的设计模式与落地陷阱。

## 为什么「让 Agent 调 python-docx」往往不够

团队第一次尝试通常会这样：

```python
from docx import Document

def edit_docx(path: str, replacements: dict[str, str]) -> str:
    doc = Document(path)
    for p in doc.paragraphs:
        for old, new in replacements.items():
            if old in p.text:
                p.text = p.text.replace(old, new)
    out = path.replace(".docx", "_edited.docx")
    doc.save(out)
    return out
```

这在 demo 里能用，生产里会快速撞墙：

| 问题 | 表现 | 根因 |
|------|------|------|
| 版式丢失 | 标题变正文、字体全乱 | 只改 `paragraph.text` 破坏 run 级样式 |
| 表格/edit 失败 | 单元格合并不对 | 表格是独立 XML 结构，不是线性段落 |
| Excel 公式损坏 | `#REF!` 满天飞 | 未区分值与公式层 |
| PPT 占位符错位 | 母版与 slide 图层冲突 | 形状树层级复杂 |
| 并发协作 | 两人同时改，后者覆盖 | 缺文件锁与变更合并策略 |

因此，文档 Agent 工具要提供的不是「一个万能 edit 函数」，而是**与业务动作对齐的高层原语 + 可预览的差异输出**。

## Tool Schema 设计：三层抽象

推荐把文档工具分成三层，由 Agent 按需组合：

```
Layer 3  业务动作     merge_template, fill_invoice, redact_pii
Layer 2  结构操作     replace_paragraph, insert_table_row, set_cell_formula
Layer 1  文件 I/O     open, save, export_pdf, list_revisions
```

### Layer 1：文件 I/O（必须幂等、可审计）

```typescript
const OpenDocument = {
  name: "office_open",
  description: "打开本地办公文档，返回 document_id 与结构摘要",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "绝对或工作区内相对路径" },
      format: { enum: ["docx", "xlsx", "pptx"] },
    },
    required: ["path", "format"],
  },
};
```

要点：

- 返回 `document_id` 而非让模型反复传路径，便于会话内状态管理
- 附带**结构摘要**（标题列表、sheet 名、slide 标题），减少盲目 `read_full`

### Layer 2：结构操作（带 preview）

```typescript
const ReplaceInParagraph = {
  name: "office_replace_text",
  description: "在指定段落范围内替换文本，保留 run 样式",
  parameters: {
    type: "object",
    properties: {
      document_id: { type: "string" },
      anchor: {
        type: "object",
        properties: {
          heading: { type: "string", description: "按标题锚定章节" },
          paragraph_index: { type: "integer" },
        },
      },
      find: { type: "string" },
      replace: { type: "string" },
      dry_run: { type: "boolean", default: true },
    },
    required: ["document_id", "find", "replace"],
  },
};
```

**`dry_run: true` 默认开启**：先返回 diff 摘要（改了哪几段、多少字符），Agent 向用户确认后再 `dry_run: false` 提交。这是办公场景的 human-in-the-loop 标配。

### Layer 3：业务动作（可封装为 Skill）

把高频场景封成单个 tool，降低模型规划错误：

- `fill_contract_template`：变量表 → 段落替换 + 附录编号
- `excel_aggregate_sales`：按 sheet 规则透视，输出新 xlsx
- `ppt_apply_brand_theme`：换母版、统一字体色板

## OfficeCLI 模式：CLI 作为 Agent 适配层

OfficeCLI 的思路是把文档能力暴露为**稳定 CLI 契约**，Agent 通过 shell tool 调用：

```bash
# 示例：列出 Word 文档大纲
office-cli docx outline ./report.docx --json

# 示例：按章节替换（伪命令，示意 CLI 粒度）
office-cli docx replace \
  --file ./report.docx \
  --section "Executive Summary" \
  --find "Q1" --replace "Q2" \
  --dry-run
```

对 Agent 编排器的意义：

1. **可测试**：CLI 用 golden file 做回归，比 prompt 稳定
2. **可沙箱**：容器里只装 CLI + 工作目录，不暴露整台办公套件
3. **可观测**：每次调用有结构化 stdout，便于 Langfuse 追踪

Python 侧也可用 `subprocess` 包装成 LangChain / LangGraph tool：

```python
import json
import subprocess
from pathlib import Path

def office_docx_outline(path: str) -> dict:
    p = Path(path).resolve()
    if not p.suffix.lower() == ".docx":
        raise ValueError("仅支持 .docx")
    proc = subprocess.run(
        ["office-cli", "docx", "outline", str(p), "--json"],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return json.loads(proc.stdout)
```

## 格式专项陷阱与对策

### Word：run 级样式

不要整体替换 `paragraph.text`。应遍历 `paragraph.runs`，仅改匹配 run 的 `text`，或重建 run 并复制 `bold/italic/font.name`。

### Excel：公式 vs 值

```python
# 反模式：把公式当字符串写入
cell.value = "=SUM(A1:A10)"  # 有时被当文本

# 正确：区分 data_only 读取与公式写入 API
cell.value = "=SUM(A1:A10)"  # openpyxl 需确保单元格格式为公式
```

Agent 工具应暴露 `read_values` 与 `read_formulas` 两个只读接口，避免模型「猜」单元格含义。

### PPT：形状 vs 文本框

一张 slide 可能有分组形状、占位符、备注页。工具返回应包含 `shape_id`，修改时按 id 定位，而非「第 3 段文字」这种脆弱坐标。

## 安全与合规：文档 Agent 的额外红线

办公文档是**敏感数据高密度载体**。Tool 设计必须叠加：

| 风险 | 防御 |
|------|------|
| 路径遍历读机密 | 工作区 chroot + 扩展名白名单 |
| 宏与外部链接 | 默认禁用宏执行；剥离 `externalReference` |
| 隐写与追踪修订 | 导出前可选「接受所有修订」「删除批注」 |
| 外传渠道 | `export` / `email` 类 tool 独立审批 |
| 幻觉式编造条款 | 法务类场景强制 `dry_run` + 人审 |

## 与 MCP 的关系：何时用 MCP Server

如果团队已标准化 MCP，可以把 OfficeCLI 封成 **MCP Server**，暴露 `resources`（文档大纲）与 `tools`（replace、export）。收益是多客户端（Cursor、Claude Desktop、自研编排器）复用同一实现；成本是要维护 MCP 鉴权与版本兼容。

简易决策：

| 场景 | 建议 |
|------|------|
| 仅内部 LangGraph 服务 | Python 直调库 / subprocess 即可 |
| 多 IDE + 多 Agent 客户端 | MCP Server |
| 强合规审计 | 独立微服务 + 操作日志库 |

## 落地 Checklist

- [ ] 定义支持的格式子集（先 docx/xlsx，pptx 后上）
- [ ] 所有写操作默认 `dry_run`，并返回人类可读的 diff
- [ ] 用 20+ 真实文档做 golden test（含表格、合并单元格、母版 PPT）
- [ ] 限制单次 Agent 会话可写文件数与总字节数
- [ ] 与网盘/IM 集成前，先解决锁与版本冲突（至少乐观锁 + etag）
- [ ] 在 observability 里单独打点 `office_*` tool 成功率与耗时

## 选型建议

| 团队阶段 | 推荐路径 |
|----------|----------|
| PoC | python-docx / openpyxl 直写 + 单文件替换 |
| 内部工具 | OfficeCLI 类 CLI 包装 + dry_run |
| 企业生产 | CLI/MCP + 审批流 + 文档沙箱 + 审计 |

办公文档不是「Office 自动化 RPA 的旧酒装新瓶」，而是 **Agent 能否进入非工程岗位的关键一公里**。把 Tool 设计成可预览、可审计、可测试的结构化原语，比让模型直接生成一段宏脚本可靠一个数量级。

---

*参考： [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)（2026-07 简报 / HN 126 分）*
