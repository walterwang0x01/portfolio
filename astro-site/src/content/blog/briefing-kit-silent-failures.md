---
title: "5 Silent Failures in My AI Briefing System (and the 237 Tests That Came After)"
date: 2026-08-07
tags: ["Open Source", "AI Agent", "Testing", "Python"]
excerpt: "I built an AI-powered daily briefing system. It 'worked perfectly' for weeks — until I discovered 5 classes of failures that pass every error check. HTTP 200, no exceptions, no warnings. But the output was wrong. Here's what happened and how I fixed each one."
vip: true
draft: false
---

I built an AI-powered daily briefing system that curates tech news from 40+ RSS sources into 3 topic briefings every morning. It worked perfectly for weeks.

Then I noticed the same article appearing in two different briefings. Then a source that had recovered weeks ago was still being skipped. Then a notification said "5 items" when the briefing clearly had 8.

**All "worked" — HTTP 200, no exceptions, no warnings, no alerts.** The pipeline was silently producing wrong output while every health check showed green.

After fixing each failure, I extracted the engine into [briefing-kit](https://github.com/walterwang0x01/briefing-kit) — an open-source Python library with 237 tests that encode every lesson. Zero external dependencies. Pure stdlib.

![Pipeline Architecture](/portfolio/images/briefing-kit/pipeline-architecture.svg)

## The Architecture (30 Seconds)

```
RSS Sources → Ingest → Classify → Candidates → [AI Agent] → Render → Validate → Publish
                ↑                      ↑                              ↑
         Circuit Breaker       Mutual-Exclusive              3-Pass Check
                                    Split
```

The engine handles everything **except** the AI curation. Your agent reads candidates, picks what matters, outputs JSON. The engine validates and publishes. This separation is why the engine has zero LLM dependencies.

---

## Failure #1: Parallel Curate Breaks Cross-Topic Dedup

![Parallel Race Condition](/portfolio/images/briefing-kit/failure-1-parallel-race.svg)

**What I saw**: Same article in both `ai-agent` and `china-tech` briefings on the same day.

**What happened**: Three AI agents curate three topics in parallel (for latency). Each agent checks "did another topic already publish this URL?" — by reading other topics' markdown files. But during parallel execution, **none of those files exist yet**. Each agent sees an empty slate.

**Why it's hard to catch**: Works perfectly when you run topics sequentially. Only manifests under parallelism, which is the production default.

**The fix**: Mutual-exclusive candidate pools. At candidate generation time (before any agent runs), each item is assigned to exactly **one** topic. Parallel curators physically cannot see the same URL.

```python
# candidates.py — each URL goes to exactly one topic
assigned_topics: dict[str, str] = {}  # url → topic
for item in scored_items:
    if item.url in assigned_topics:
        continue  # already claimed
    assigned_topics[item.url] = item.main_topic
```

**Regression test**: `test_candidates.py::TestMutualExclusion` — verifies no URL appears in more than one topic's output.

---

## Failure #2: Circuit Breaker Never Self-Heals

![Circuit Breaker State Machine](/portfolio/images/briefing-kit/failure-2-circuit-breaker.svg)

**What I saw**: A source got tripped (3 consecutive failures) and stayed tripped for 3 weeks, long after the source recovered.

**What happened**: When a source is tripped, ingest skips it entirely — including the `record_source_result()` call. So `consecutive_failures` is frozen at 3. There's no code path that decrements it back to 0. The source is permanently dead without manual intervention.

**Why it's hard to catch**: The health dashboard shows "tripped" which looks intentional. No alert fires. The system is "working correctly" — just never giving the source another chance.

**The fix**: Half-open probe. After `retry_after_days` (default: 7), the breaker enters half-open state. One request goes through. Success → reset. Failure → re-trip and restart timer.

```python
# health.py
def should_probe(source_id: str, health: dict) -> bool:
    """Half-open: after retry_after_days, allow one probe request."""
    last_fail = health[source_id]["last_failure_date"]
    days_since = (today() - last_fail).days
    return days_since >= cfg.circuit_breaker.retry_after_days
```

**Regression test**: `test_health.py::TestHalfOpenProbe` with frozen time — verifies probe triggers at exactly day 7.

---

## Failure #3: Push Count Misses Free-Form Items

![Count Miss](/portfolio/images/briefing-kit/failure-3-count-miss.svg)

**What I saw**: Bark notification says "5 items" but the briefing actually has 8 items.

**What happened**: `count_briefing_items()` only counts `### Title` (H3 headers). But some sections use bullet format: `**Title** — description`. These are real content items but invisible to the counter.

**Why it's hard to catch**: Push notifications are a convenience. Nobody cross-references the count against the file. Being off by 3 doesn't trigger any alert.

**The fix**: Multi-format counter that recognizes all item patterns:

```python
def count_briefing_items(md: str) -> int:
    count = 0
    for line in md.splitlines():
        if line.startswith("### "):           count += 1  # H3 items
        elif re.match(r"\*\*.+\*\*\s*[—–-]", line):  count += 1  # Bold-dash
        elif re.match(r"^\d+\.\s+\*\*", line): count += 1  # Numbered
    return count
```

---

## Failure #4: Web Search Links Bypass All Dedup

![Dedup Bypass](/portfolio/images/briefing-kit/failure-4-dedup-bypass.svg)

**What I saw**: A URL from yesterday's briefing reappears today.

**What happened**: The AI agent sometimes supplements its curation with web search results to fill coverage gaps. These supplemented links enter the render stage **directly** — they never pass through the candidate pool. The candidate pool is where URL dedup happens.

**Why it's hard to catch**: Supplements are occasional. The duplicate comes from a different context (yesterday, different topic). Readers rarely notice.

**The fix**: Unified URL registry check. Before *any* URL enters the final render, regardless of how it arrived:

```python
# storage.py — single source of truth
def check_url_reuse(url: str, topic: str, date: str) -> list[dict]:
    """Check if URL was published in any topic on any date."""
    index = load_published_index()
    return [entry for entry in index if entry["url"] == normalize_url(url)]
```

---

## Failure #5: HTTP 200 + Valid XML + Zero Items = "Success"

![Silent Empty](/portfolio/images/briefing-kit/failure-5-silent-empty.svg)

**What I saw**: Pipeline reports complete success. But no briefing file was produced today.

**What happened**: An RSS feed returns a valid HTTP response with a valid XML body containing an empty `<channel>` (zero `<item>` elements). Every check passes:

| Check | Result |
|---|---|
| HTTP status | 200 ✅ |
| Content-Type | application/xml ✅ |
| XML parsing | Success ✅ |
| Items extracted | 0 (no error — empty list is valid) |

The pipeline continues with an empty pool, empty candidates, and no output. Status shows "not curated yet" — which looks like the agent hasn't run, not that data was empty.

**The fix**: Zero-output detection at multiple stages:

1. After ingest: if HTTP succeeded but 0 items → warning with source URL
2. After candidates: if total across all topics is 0 → hard warning
3. In status: distinguish "not run" vs "ran but empty"

---

## Lessons

These 5 failures share a pattern: **they live in the gap between "no error" and "correct output."** Standard error handling (try/except, HTTP status checks, schema validation) doesn't catch them because nothing technically went wrong.

What works:

1. **Assert on output properties, not just absence of errors** — "items > 0" is a stronger signal than "no exception"
2. **Test the concurrent path, not just sequential** — Race conditions only appear under parallelism
3. **Make state transitions explicit** — A circuit breaker with no reset path is a one-way door
4. **Dedup at the narrowest chokepoint** — Runtime checks between parallel writers always have a window
5. **Distinguish "hasn't run" from "ran but empty"** — They look identical from the outside

---

## Try It

```bash
pip install briefing-kit   # (coming to PyPI soon)
# Or clone directly:
git clone https://github.com/walterwang0x01/briefing-kit
cd briefing-kit && python -m pytest tests/  # 237 tests, 0.2s
```

The engine is designed so you bring your own AI agent. It handles the boring-but-critical infrastructure: fetching, deduplication, health monitoring, validation. Your agent handles the interesting part: deciding what matters.

[GitHub →](https://github.com/walterwang0x01/briefing-kit)
