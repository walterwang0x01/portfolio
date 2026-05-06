#!/usr/bin/env bash
# 一次性脚本：批量创建 Astro 项目的骨架文件
# 执行后可删
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p src/layouts src/pages/posts src/components src/styles public

# ============ 全局样式 ============
cat > src/styles/global.css <<'CSS'
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f7f8fa;
  --text-primary: #1a1a1a;
  --text-secondary: #4a4a4a;
  --text-tertiary: #8a8a8a;
  --border-color: #e5e7eb;
  --card-bg: #ffffff;
  --primary: #2563eb;
  --primary-hover: #1d4ed8;
  --badge-bg: #eff6ff;
  --transition: all 0.18s ease;
}
[data-theme="dark"] {
  --bg-primary: #0f1115;
  --bg-secondary: #171a20;
  --text-primary: #f3f4f6;
  --text-secondary: #d1d5db;
  --text-tertiary: #9ca3af;
  --border-color: #2a2f37;
  --card-bg: #171a20;
  --primary: #60a5fa;
  --primary-hover: #93c5fd;
  --badge-bg: #1e3a8a;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro SC", "Segoe UI",
    "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  line-height: 1.7;
  min-height: 100vh;
}
a { color: var(--primary); text-decoration: none; transition: var(--transition); }
a:hover { color: var(--primary-hover); }
img { max-width: 100%; height: auto; }
.skip-link { position: absolute; left: -9999px; top: 0; background: var(--primary); color: #fff; padding: 8px 14px; z-index: 9999; border-radius: 0 0 6px 0; }
.skip-link:focus { left: 0; }
.navbar { position: sticky; top: 0; z-index: 100; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border-color); }
[data-theme="dark"] .navbar { background: rgba(15,17,21,0.85); }
.navbar-inner { max-width: 1100px; margin: 0 auto; padding: 14px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.navbar-brand { font-weight: 700; font-size: 16px; color: var(--text-primary); }
.navbar-links { display: flex; gap: 22px; list-style: none; }
.navbar-links a { color: var(--text-secondary); font-size: 14px; font-weight: 500; }
.navbar-links a.active, .navbar-links a:hover { color: var(--primary); }
.theme-toggle, .menu-toggle { background: none; border: 1px solid var(--border-color); color: var(--text-primary); border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
.menu-toggle { display: none; }
@media (max-width: 768px) { .navbar-links { display: none; } .menu-toggle { display: inline-flex; } }
.mobile-nav { display: none; list-style: none; padding: 8px 24px 16px; border-top: 1px solid var(--border-color); background: var(--bg-primary); }
.mobile-nav.open { display: block; }
.mobile-nav li { padding: 10px 0; }
.mobile-nav a { color: var(--text-secondary); }
.container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
.container-narrow { max-width: 800px; margin: 0 auto; padding: 32px 24px; }
.badge { display: inline-block; padding: 3px 10px; border-radius: 12px; background: var(--badge-bg); color: var(--primary); font-size: 12px; font-weight: 500; margin-right: 6px; }
footer { text-align: center; padding: 24px; color: var(--text-tertiary); font-size: 13px; border-top: 1px solid var(--border-color); margin-top: 48px; }
.post-body { font-size: 16px; line-height: 1.85; color: var(--text-secondary); }
.post-body h1, .post-body h2, .post-body h3 { color: var(--text-primary); margin: 28px 0 14px; line-height: 1.4; }
.post-body h1 { font-size: 26px; border-bottom: 2px solid var(--primary); padding-bottom: 10px; }
.post-body h2 { font-size: 22px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; }
.post-body h3 { font-size: 18px; }
.post-body p { margin-bottom: 16px; }
.post-body ul, .post-body ol { margin: 0 0 16px 24px; }
.post-body li { margin-bottom: 6px; }
.post-body strong { color: var(--text-primary); }
.post-body blockquote { border-left: 4px solid var(--primary); padding: 12px 16px; background: var(--bg-secondary); border-radius: 0 10px 10px 0; margin: 18px 0; color: var(--text-secondary); font-style: italic; }
.post-body code { background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; font-family: "SF Mono", "Fira Code", Menlo, Consolas, monospace; color: var(--primary); }
.post-body pre { background: var(--bg-secondary); padding: 16px; border-radius: 10px; overflow-x: auto; margin-bottom: 16px; border: 1px solid var(--border-color); }
.post-body pre code { background: none; padding: 0; color: var(--text-primary); font-size: 13px; }
.post-card { background: var(--card-bg); border: 1px solid var(--border-color); border-radius: 14px; padding: 20px 22px; margin-bottom: 16px; transition: var(--transition); display: block; color: inherit; }
.post-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
.post-card h2 { font-size: 18px; margin-bottom: 8px; color: var(--text-primary); }
.post-card .meta { font-size: 13px; color: var(--text-tertiary); margin-bottom: 10px; }
.post-card .excerpt { font-size: 14px; color: var(--text-secondary); margin-bottom: 10px; }
CSS

# ============ BaseLayout ============
cat > src/layouts/BaseLayout.astro <<'ASTRO'
---
import '@/styles/global.css';

interface Props {
  title: string;
  description?: string;
  activeNav?: 'blog' | 'briefing';
}

const { title, description = "Walter's Tech Blog — AI Agent 与工程实践", activeNav = 'blog' } = Astro.props;
const canonical = new URL(Astro.url.pathname, Astro.site).toString();
const BASE = import.meta.env.BASE_URL;
---
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <link rel="canonical" href={canonical} />
    <link rel="alternate" type="application/rss+xml" title="RSS" href={`${BASE}rss.xml`} />
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>" />
    <meta property="og:title" content={title} />
    <meta property="og:description" content={description} />
    <meta property="og:url" content={canonical} />
    <meta property="og:type" content="website" />
    <title>{title}</title>
    <script is:inline>
      const saved = localStorage.getItem('theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
      else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme', 'dark');
    </script>
  </head>
  <body>
    <a class="skip-link" href="#main">跳转到主内容</a>
    <nav class="navbar" aria-label="主导航">
      <div class="navbar-inner">
        <a class="navbar-brand" href={BASE}>⚡ Walter's Tech Blog</a>
        <ul class="navbar-links">
          <li><a href={BASE} class={activeNav === 'blog' ? 'active' : ''}>博客</a></li>
          <li><a href={`${BASE}briefing/`} class={activeNav === 'briefing' ? 'active' : ''}>简报</a></li>
          <li><a href="https://github.com/WalterHandsome/tech-learning-and-projects" target="_blank" rel="noopener">GitHub ↗</a></li>
        </ul>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="menu-toggle" id="menuToggle" aria-label="打开导航菜单" aria-expanded="false">☰</button>
          <button class="theme-toggle" id="themeToggle" aria-label="切换主题">🌙</button>
        </div>
      </div>
      <ul class="mobile-nav" id="mobileNav">
        <li><a href={BASE}>博客</a></li>
        <li><a href={`${BASE}briefing/`}>简报</a></li>
        <li><a href="https://github.com/WalterHandsome/tech-learning-and-projects" target="_blank" rel="noopener">GitHub ↗</a></li>
      </ul>
    </nav>
    <main id="main"><slot /></main>
    <footer><p>© {new Date().getFullYear()} Walter's Tech Blog · Powered by Astro</p></footer>
    <script>
      const toggle = document.getElementById('themeToggle');
      const root = document.documentElement;
      toggle?.addEventListener('click', () => {
        const cur = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', cur);
        localStorage.setItem('theme', cur);
        if (toggle) toggle.textContent = cur === 'dark' ? '☀️' : '🌙';
      });
      if (toggle) toggle.textContent = root.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
      const menuBtn = document.getElementById('menuToggle');
      const mobileNav = document.getElementById('mobileNav');
      menuBtn?.addEventListener('click', () => {
        const open = mobileNav?.classList.toggle('open');
        menuBtn.setAttribute('aria-expanded', String(!!open));
      });
    </script>
  </body>
</html>
ASTRO

# ============ PostLayout ============
cat > src/layouts/PostLayout.astro <<'ASTRO'
---
import BaseLayout from './BaseLayout.astro';

interface Props {
  title: string;
  date: Date;
  tags: string[];
  excerpt: string;
}

const { title, date, tags, excerpt } = Astro.props;
const dateStr = date.toISOString().slice(0, 10);
const BASE = import.meta.env.BASE_URL;
---
<BaseLayout title={`${title} — Walter's Tech Blog`} description={excerpt}>
  <article class="container-narrow">
    <header style="margin-bottom: 32px;">
      <a href={BASE} style="font-size: 14px; color: var(--text-tertiary)">← 返回博客列表</a>
      <h1 style="font-size: 30px; margin: 16px 0 12px; color: var(--text-primary)">{title}</h1>
      <div style="font-size: 13px; color: var(--text-tertiary); display:flex; gap: 12px; align-items:center; flex-wrap:wrap;">
        <span>📅 <time datetime={dateStr}>{dateStr}</time></span>
        <span>·</span>
        <div>{tags.map((t: string) => <span class="badge">{t}</span>)}</div>
      </div>
    </header>
    <div class="post-body"><slot /></div>
    <hr style="margin: 48px 0 24px; border: none; border-top: 1px solid var(--border-color)" />
    <div id="comments"></div>
  </article>
  <script is:inline>
    (function () {
      const slug = location.pathname.replace(/^.*\/posts\//, '').replace(/\/$/, '');
      const container = document.getElementById('comments');
      if (!container) return;
      container.innerHTML = '<h3 style="margin-bottom: 12px; color: var(--text-primary)">💬 评论</h3>';
      const s = document.createElement('script');
      s.src = 'https://giscus.app/client.js';
      s.setAttribute('data-repo', 'WalterHandsome/portfolio');
      s.setAttribute('data-repo-id', 'R_kgDOSFA_HQ');
      s.setAttribute('data-category', 'Announcements');
      s.setAttribute('data-category-id', 'DIC_kwDOSFA_Hc4C7Q-z');
      s.setAttribute('data-mapping', 'specific');
      s.setAttribute('data-term', slug);
      s.setAttribute('data-strict', '0');
      s.setAttribute('data-reactions-enabled', '1');
      s.setAttribute('data-emit-metadata', '0');
      s.setAttribute('data-input-position', 'top');
      s.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
      s.setAttribute('data-lang', 'zh-CN');
      s.setAttribute('crossorigin', 'anonymous');
      s.async = true;
      container.appendChild(s);
    })();
  </script>
</BaseLayout>
ASTRO

# ============ 首页 ============
cat > src/pages/index.astro <<'ASTRO'
---
import { getCollection } from 'astro:content';
import BaseLayout from '@/layouts/BaseLayout.astro';

const all = await getCollection('blog', ({ data }) => !data.draft);
const posts = all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
const allTags = [...new Set(posts.flatMap((p) => p.data.tags))];
const BASE = import.meta.env.BASE_URL;
---
<BaseLayout title="Walter's Tech Blog" activeNav="blog">
  <section class="container-narrow">
    <h1 style="font-size: 28px; margin-bottom: 8px; color: var(--text-primary)">⚡ Walter's Tech Blog</h1>
    <p style="color: var(--text-tertiary); margin-bottom: 24px;">AI Agent · 工程实践 · 系统设计</p>
    <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom: 20px;">
      <input id="searchInput" type="search" placeholder="搜索文章标题、摘要、标签…" style="flex:1; min-width: 220px; padding: 10px 14px; border:1px solid var(--border-color); border-radius: 10px; background: var(--card-bg); color: var(--text-primary); font-size: 14px;" />
    </div>
    <div id="tagFilter" style="margin-bottom: 20px; display:flex; flex-wrap:wrap; gap:8px;">
      <button class="badge" data-tag="" style="cursor:pointer;border:none;">全部</button>
      {allTags.map((t) => (<button class="badge" data-tag={t} style="cursor:pointer;border:none;">{t}</button>))}
    </div>
    <div id="postList">
      {posts.map((p) => (
        <a class="post-card" href={`${BASE}posts/${p.slug}/`} data-title={p.data.title} data-excerpt={p.data.excerpt} data-tags={p.data.tags.join(',')}>
          <h2>{p.data.title}</h2>
          <div class="meta">
            <time datetime={p.data.date.toISOString().slice(0,10)}>{p.data.date.toISOString().slice(0,10)}</time>
            {' · '}
            {p.data.tags.map((t) => <span class="badge">{t}</span>)}
          </div>
          <p class="excerpt">{p.data.excerpt}</p>
        </a>
      ))}
    </div>
  </section>
  <script>
    (function () {
      const hash = location.hash.slice(1);
      if (!hash) return;
      const target = document.querySelector(`a.post-card[href$="/posts/${hash}/"]`);
      if (target) {
        const href = (target as HTMLAnchorElement).href;
        history.replaceState(null, '', href);
        location.replace(href);
      }
    })();
    const input = document.getElementById('searchInput') as HTMLInputElement | null;
    const tagBar = document.getElementById('tagFilter');
    const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>('#postList .post-card'));
    let activeTag = '';
    let query = '';
    function apply() {
      const q = query.toLowerCase();
      for (const c of cards) {
        const title = c.dataset.title?.toLowerCase() ?? '';
        const excerpt = c.dataset.excerpt?.toLowerCase() ?? '';
        const tags = (c.dataset.tags ?? '').split(',');
        const matchQ = !q || title.includes(q) || excerpt.includes(q) || tags.some((t) => t.toLowerCase().includes(q));
        const matchT = !activeTag || tags.includes(activeTag);
        c.style.display = matchQ && matchT ? '' : 'none';
      }
    }
    input?.addEventListener('input', () => { query = input.value.trim(); apply(); });
    tagBar?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-tag]') as HTMLButtonElement | null;
      if (!btn) return;
      activeTag = btn.dataset.tag ?? '';
      apply();
    });
  </script>
</BaseLayout>
ASTRO

# ============ 文章详情 ============
cat > src/pages/posts/[...slug].astro <<'ASTRO'
---
import { getCollection } from 'astro:content';
import PostLayout from '@/layouts/PostLayout.astro';

export async function getStaticPaths() {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return posts.map((p) => ({ params: { slug: p.slug }, props: { post: p } }));
}

const { post } = Astro.props;
const { Content } = await post.render();
---
<PostLayout title={post.data.title} date={post.data.date} tags={post.data.tags} excerpt={post.data.excerpt}>
  <Content />
</PostLayout>
ASTRO

# ============ 简报页 ============
cat > src/pages/briefing.astro <<'ASTRO'
---
import BaseLayout from '@/layouts/BaseLayout.astro';
---
<BaseLayout title="每日简报 — Walter's Tech Blog" description="AI Agent · 国内科技 · 国际科技每日简报" activeNav="briefing">
  <section class="container-narrow">
    <h1 style="font-size: 26px; margin-bottom: 6px; color: var(--text-primary)">📰 每日技术简报</h1>
    <p style="color: var(--text-tertiary); margin-bottom: 20px;">AI Agent · 国内科技 · 国际科技 — 每日精选，自动采集</p>
    <div id="topicTabs" style="display:flex; gap:8px; margin-bottom: 16px; flex-wrap:wrap;">
      <button class="badge" data-topic="ai-agent" style="cursor:pointer;border:none;">🤖 AI Agent</button>
      <button class="badge" data-topic="china-tech" style="cursor:pointer;border:none;">🇨🇳 国内科技</button>
      <button class="badge" data-topic="global-tech" style="cursor:pointer;border:none;">🌍 国际科技</button>
    </div>
    <div id="dateList" style="display:flex; gap:6px; margin-bottom: 16px; overflow-x:auto; padding-bottom:4px;"></div>
    <div id="briefingContent" class="post-body" style="padding: 20px; border: 1px solid var(--border-color); border-radius: 12px; background: var(--card-bg);">
      <div style="text-align:center; padding: 40px; color: var(--text-tertiary);">加载中…</div>
    </div>
  </section>
  <script src="https://cdn.jsdelivr.net/npm/marked@15/marked.min.js"></script>
  <script is:inline>
    (function () {
      const REPO = 'WalterHandsome/tech-learning-and-projects';
      const BRANCH = 'main';
      const BASE_API = `https://api.github.com/repos/${REPO}/contents/learning-notes/briefings`;
      const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/learning-notes/briefings`;
      let topic = 'ai-agent', date = null;
      const dateCache = {}, contentCache = {};
      const tabs = document.getElementById('topicTabs');
      const dateList = document.getElementById('dateList');
      const content = document.getElementById('briefingContent');

      async function fetchDates(t) {
        if (dateCache[t]) return dateCache[t];
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth() + 1;
        const dates = [];
        for (let i = m; i >= Math.max(1, m - 2); i--) {
          const mm = String(i).padStart(2, '0');
          try {
            const r = await fetch(`${BASE_API}/${t}/${y}/${mm}`, { headers: { Accept: 'application/vnd.github.v3+json' }});
            if (!r.ok) continue;
            const files = await r.json();
            for (const f of files) {
              const m2 = f.name.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
              if (m2) dates.push(m2[1]);
            }
          } catch (_) {}
        }
        dates.sort((a, b) => b.localeCompare(a));
        dateCache[t] = dates;
        return dates;
      }

      async function fetchContent(t, d) {
        const k = `${t}/${d}`;
        if (contentCache[k]) return contentCache[k];
        const [y, mo] = d.split('-');
        const r = await fetch(`${RAW}/${t}/${y}/${mo}/${d}.md`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const md = await r.text();
        contentCache[k] = md;
        return md;
      }

      function render(md) {
        md = md.replace(/<!--[\s\S]*?-->/g, '').replace(/^---[\s\S]*?---\n*/m, '');
        return window.marked.parse(md, { breaks: true, gfm: true });
      }

      async function switchTopic(t) {
        topic = t;
        content.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-tertiary);">加载中…</div>';
        const dates = await fetchDates(t);
        if (!dates.length) {
          dateList.innerHTML = '';
          content.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-tertiary);">📭 暂无简报</div>';
          return;
        }
        const d = date && dates.includes(date) ? date : dates[0];
        date = d;
        dateList.innerHTML = dates.slice(0, 14).map((x) =>
          `<button class="badge" data-date="${x}" style="cursor:pointer;border:none;${x === d ? 'background:var(--primary);color:#fff' : ''}">${x.slice(5)}</button>`
        ).join('');
        await load(t, d);
      }

      async function load(t, d) {
        date = d;
        try {
          const md = await fetchContent(t, d);
          content.innerHTML = render(md);
        } catch (e) {
          content.innerHTML = `<div style="text-align:center; padding: 40px; color: var(--text-tertiary);">😕 加载失败：${e.message}</div>`;
        }
      }

      tabs.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-topic]');
        if (b) { date = null; switchTopic(b.dataset.topic); }
      });
      dateList.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-date]');
        if (b) load(topic, b.dataset.date);
      });

      switchTopic(topic);
    })();
  </script>
</BaseLayout>
ASTRO

# ============ RSS ============
cat > src/pages/rss.xml.ts <<'TS'
import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => !data.draft);
  return rss({
    title: "Walter's Tech Blog",
    description: 'AI Agent、工程实践、系统设计',
    site: context.site!,
    items: posts
      .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
      .map((p) => ({
        title: p.data.title,
        pubDate: p.data.date,
        description: p.data.excerpt,
        categories: p.data.tags,
        link: `/posts/${p.slug}/`,
      })),
  });
}
TS

# ============ robots.txt ============
cat > public/robots.txt <<'TXT'
User-agent: *
Allow: /

Sitemap: https://walterhandsome.github.io/portfolio/sitemap-index.xml
TXT

# ============ README ============
cat > README.md <<'MD'
# Walter's Tech Blog — Astro 重构版

基于 Astro + Markdown 的生产级博客。

## 快速开始

```bash
npm install
npm run migrate     # 从 ../index.html 抽出文章生成 Markdown
npm run dev
npm run build
```

## Frontmatter

```yaml
---
title: "文章标题"
date: 2026-05-06
tags: [AI Agent, MCP]
excerpt: "摘要"
vip: false
draft: false
---
```

## 部署

Cloudflare Pages：
- 构建命令：`npm run build`
- 产物目录：`dist/`
MD

echo "✅ 骨架文件落盘完成"
find src public -type f | sort
