#!/usr/bin/env python3
"""博客站点 HTML/CSS 纯脚本校验（零依赖，零 LLM）.

场景：fileEdited 事件触发，对保存后的 .html/.css 做最小校验，
发现问题输出 WARNING（非阻断）。规则刻意保持简单，避免假阳。

覆盖检查：
- HTML: <div>/<section>/<script> 配对数一致；<meta charset> 存在
- CSS:  花括号配对；声明缺分号（粗略）

跨项目短路：文件路径不在博客站点（portfolio）下直接 exit 0。
"""
from __future__ import annotations

import json
import os
import re
import sys

PROJECT_KEY = "portfolio"
TAG_CHECK = ("div", "section", "script")


def _check_html(content: str) -> list[str]:
    problems: list[str] = []
    for tag in TAG_CHECK:
        opens = len(re.findall(rf"<{tag}\b", content, re.IGNORECASE))
        closes = len(re.findall(rf"</{tag}>", content, re.IGNORECASE))
        if abs(opens - closes) > 1:
            problems.append(f"<{tag}> 开闭不平衡（open={opens}, close={closes}）")
    if "<meta" in content.lower() and "charset" not in content.lower():
        problems.append("<meta> 缺少 charset")
    return problems


def _check_css(content: str) -> list[str]:
    problems: list[str] = []
    opens = content.count("{")
    closes = content.count("}")
    if opens != closes:
        problems.append(f"花括号不平衡（{{={opens}, }}={closes}）")
    decl_missing = re.findall(r"[A-Za-z\-]+\s*:\s*[^;{\n]+\n\s*}", content)
    if decl_missing:
        problems.append(f"发现 {len(decl_missing)} 处可能缺少分号的声明")
    return problems


def main() -> int:
    raw = os.environ.get("KIRO_TOOL_INPUT", "")
    if not raw:
        return 0
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return 0

    path = data.get("path") or data.get("targetFile") or ""
    if not isinstance(path, str) or not path:
        return 0

    abs_path = os.path.abspath(path)
    if PROJECT_KEY not in abs_path:
        return 0

    lower = path.lower()
    if not (lower.endswith(".html") or lower.endswith(".css")):
        return 0

    try:
        with open(abs_path, encoding="utf-8") as handle:
            content = handle.read()
    except OSError:
        return 0

    problems = _check_html(content) if lower.endswith(".html") else _check_css(content)
    if problems:
        print("WARNING: " + "；".join(problems[:3]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
