// 博客卡片/详情页共用的小工具：自动封面 + 阅读时长

// 8 种预设渐变，稳定且在明暗两种主题下都能看
const GRADIENTS = [
  'linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)', // indigo → pink
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 50%, #6366f1 100%)', // cyan → indigo
  'linear-gradient(135deg, #10b981 0%, #14b8a6 50%, #06b6d4 100%)', // emerald → cyan
  'linear-gradient(135deg, #f59e0b 0%, #ef4444 50%, #ec4899 100%)', // amber → pink
  'linear-gradient(135deg, #8b5cf6 0%, #6366f1 50%, #3b82f6 100%)', // purple → blue
  'linear-gradient(135deg, #14b8a6 0%, #3b82f6 50%, #8b5cf6 100%)', // teal → purple
  'linear-gradient(135deg, #f43f5e 0%, #f97316 50%, #eab308 100%)', // rose → yellow
  'linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 50%, #d946ef 100%)', // sky → fuchsia
];

// 常见 tag 的固定 emoji，没命中就用 💡
const TAG_EMOJI: Record<string, string> = {
  'AI Agent': '🤖',
  'Agent 架构': '🤖',
  'Agent 框架': '⚙️',
  'Agent 安全': '🛡️',
  'Agent 支付': '💳',
  'Agent 协议': '🔗',
  'Agentic 设计模式': '🧩',
  'LLM': '🧠',
  'LLM 工程': '🧠',
  '多 Agent': '👥',
  'LangGraph': '📊',
  'CrewAI': '🧑\u200d🤝\u200d🧑',
  'MCP': '🔌',
  'A2A': '🔄',
  '协议': '📜',
  'RAG': '📚',
  'GraphRAG': '🕸️',
  '知识图谱': '🕸️',
  '向量数据库': '🗂️',
  '记忆系统': '🧠',
  'Context Engineering': '📝',
  'Prompt 注入': '⚠️',
  'Voice Agent': '🎙️',
  'Realtime API': '⚡',
  'Coding Agent': '💻',
  'Vibe Coding': '💻',
  'Claude Code': '💻',
  'Computer Use': '🖥️',
  '浏览器自动化': '🌐',
  'Function Calling': '🛠️',
  '工具调用': '🛠️',
  'AI 网关': '🚪',
  '模型路由': '🚦',
  '可观测性': '📈',
  '评估': '✅',
  '工作流': '🔀',
  '工程化': '🏗️',
  '架构设计': '🏛️',
  '基础设施': '🏗️',
  'Harness Engineering': '🏗️',
  'x402': '💰',
  'USDC': '💵',
  '入门指南': '🌱',
};

// djb2 hash，稳定把字符串映射到一个整数
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function pickGradient(seed: string): string {
  return GRADIENTS[hashString(seed) % GRADIENTS.length];
}

export function pickEmoji(tags: string[], override?: string): string {
  if (override) return override;
  for (const t of tags) {
    if (TAG_EMOJI[t]) return TAG_EMOJI[t];
  }
  return '💡';
}

/**
 * 基于中文 250 字/分钟、英文 220 词/分钟估算阅读时长。
 * 返回向上取整的分钟数，最少 1 分钟。
 */
export function readingMinutes(raw: string): number {
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/<[^>]*>/g, '');
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9]+/g) ?? []).length;
  const minutes = cjk / 250 + words / 220;
  return Math.max(1, Math.ceil(minutes));
}


export interface RelatedCandidate {
  slug: string;
  data: { title: string; date: Date; tags: string[]; excerpt: string; cover?: string; emoji?: string };
  body: string;
}

/**
 * 按标签重合度找最相关的 N 篇文章，重合度相同时用日期降序。
 * 排除当前文章本身。
 */
export function findRelated(current: RelatedCandidate, all: RelatedCandidate[], limit = 3): RelatedCandidate[] {
  const currentTags = new Set(current.data.tags);
  const scored = all
    .filter((p) => p.slug !== current.slug)
    .map((p) => {
      const overlap = p.data.tags.filter((t) => currentTags.has(t)).length;
      return { post: p, overlap };
    })
    .filter((x) => x.overlap > 0);

  scored.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return b.post.data.date.valueOf() - a.post.data.date.valueOf();
  });

  // 如果标签重合不够，就用最新文章补齐
  const picked = scored.slice(0, limit).map((x) => x.post);
  if (picked.length < limit) {
    const pickedSlugs = new Set(picked.map((p) => p.slug));
    const fallback = all
      .filter((p) => p.slug !== current.slug && !pickedSlugs.has(p.slug))
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .slice(0, limit - picked.length);
    picked.push(...fallback);
  }
  return picked;
}


/**
 * 同一个标签始终映射到同一个颜色（0-5），和 CSS `.badge[data-color]` 配合使用。
 */
export function pickTagColorIndex(tag: string): number {
  // 复用上面的 djb2 哈希（同模块内重新定义以免导出私有符号）
  let h = 5381;
  for (let i = 0; i < tag.length; i++) h = ((h << 5) + h + tag.charCodeAt(i)) | 0;
  return Math.abs(h) % 6;
}
