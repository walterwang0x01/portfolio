#!/usr/bin/env bash
# 阶段 3 + 阶段 4 的文件更新脚本
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p src/components ../.github/workflows public

# ============ Analytics 组件（51.la + 不蒜子） ============
cat > src/components/Analytics.astro <<'ASTRO'
---
// 与原站点完全一致：51.la + 不蒜子，异步加载不阻塞首屏
---
<script is:inline>
  window.addEventListener('load', function () {
    var s = document.createElement('script');
    s.src = '//sdk.51.la/js-sdk-pro.min.js';
    s.charset = 'UTF-8';
    s.onload = function () {
      LA.init({ id: '3PeZ4JAmjD4FHOcx', ck: '3PeZ4JAmjD4FHOcx', autoTrack: true, hashMode: true, screenRecord: true });
    };
    document.head.appendChild(s);
  });
</script>
<script async src="//busuanzi.ibruce.info/busuanzi/2.3/busuanzi.pure.mini.js"></script>
ASTRO

# ============ 回到顶部 ============
cat > src/components/BackToTop.astro <<'ASTRO'
<button id="backToTop" aria-label="回到顶部" title="回到顶部">↑</button>
<style>
  #backToTop {
    position: fixed; right: 24px; bottom: 32px;
    width: 40px; height: 40px; border-radius: 50%;
    background: var(--primary); color: #fff;
    border: none; font-size: 18px; cursor: pointer;
    opacity: 0; pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 99;
  }
  #backToTop.visible { opacity: 1; pointer-events: auto; }
  #backToTop:hover { transform: translateY(-2px); }
</style>
<script>
  const btn = document.getElementById('backToTop');
  btn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  window.addEventListener('scroll', () => {
    btn?.classList.toggle('visible', window.scrollY > 400);
  });
</script>
ASTRO

# ============ 文章增强：TOC + 代码复制 + 阅读进度 ============
cat > src/components/PostEnhance.astro <<'ASTRO'
<div id="readingProgress"></div>
<style>
  #readingProgress {
    position: fixed; top: 0; left: 0; height: 3px; width: 0;
    background: var(--primary); z-index: 101;
    transition: width 0.1s ease;
  }
  .post-toc {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 14px 18px;
    margin: 0 0 28px;
    font-size: 14px;
  }
  .post-toc .toc-title { font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
  .post-toc a { display: block; color: var(--text-secondary); padding: 3px 0; }
  .post-toc a:hover { color: var(--primary); }
  .code-copy-btn {
    position: absolute; top: 8px; right: 8px;
    background: var(--card-bg); border: 1px solid var(--border-color);
    color: var(--text-secondary); font-size: 12px;
    padding: 3px 10px; border-radius: 6px; cursor: pointer;
    opacity: 0; transition: opacity 0.15s ease;
  }
  .post-body pre { position: relative; }
  .post-body pre:hover .code-copy-btn { opacity: 1; }
  .code-copy-btn.copied { color: var(--primary); border-color: var(--primary); }
</style>
<script>
  const bar = document.getElementById('readingProgress');
  if (bar) {
    window.addEventListener('scroll', () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      bar.style.width = max > 0 ? Math.min(100, (window.scrollY / max) * 100) + '%' : '0';
    });
  }
  const body = document.querySelector('.post-body');
  if (body) {
    const hs = body.querySelectorAll('h2');
    if (hs.length >= 2) {
      const nav = document.createElement('nav');
      nav.className = 'post-toc';
      nav.setAttribute('aria-label', '文章目录');
      nav.innerHTML = '<div class="toc-title">📑 目录</div>' +
        Array.from(hs).map((h, i) => {
          if (!h.id) h.id = 'h-' + i;
          return `<a href="#${h.id}">${h.textContent}</a>`;
        }).join('');
      body.insertBefore(nav, body.firstChild);
      nav.querySelectorAll('a').forEach((a) => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const id = a.getAttribute('href')?.slice(1);
          if (id) document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
        });
      });
    }
    body.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.textContent = '复制';
      btn.setAttribute('aria-label', '复制代码');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        const text = code ? code.textContent ?? '' : pre.textContent ?? '';
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '已复制 ✓';
          btn.classList.add('copied');
          setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1500);
        });
      });
      pre.appendChild(btn);
    });
  }
</script>
ASTRO

# ============ BaseLayout：接入 Analytics + BackToTop + 不蒜子显示 ============
cat > src/layouts/BaseLayout.astro <<'ASTRO'
---
import '@/styles/global.css';
import Analytics from '@/components/Analytics.astro';
import BackToTop from '@/components/BackToTop.astro';

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
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={title} />
    <meta name="twitter:description" content={description} />
    <title>{title}</title>
    <script is:inline>
      const saved = localStorage.getItem('theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
      else if (window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme', 'dark');
    </script>
    <Analytics />
  </head>
  <body>
    <a class="skip-link" href="#main">跳转到主内容</a>
    <nav class="navbar" aria-label="主导航">
      <div class="navbar-inner">
        <a class="navbar-brand" href={BASE}>⚡ Walter's Tech Blog</a>
        <ul class="navbar-links">
          <li><a href={BASE} class={activeNav === 'blog' ? 'active' : ''}>博客</a></li>
          <li><a href={`${BASE}briefing/`} class={activeNav === 'briefing' ? 'active' : ''}>简报</a></li>
          <li><a href="https://github.com/walterwang0x01/tech-learning-and-projects" target="_blank" rel="noopener">GitHub ↗</a></li>
        </ul>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="menu-toggle" id="menuToggle" aria-label="打开导航菜单" aria-expanded="false">☰</button>
          <button class="theme-toggle" id="themeToggle" aria-label="切换主题">🌙</button>
        </div>
      </div>
      <ul class="mobile-nav" id="mobileNav">
        <li><a href={BASE}>博客</a></li>
        <li><a href={`${BASE}briefing/`}>简报</a></li>
        <li><a href="https://github.com/walterwang0x01/tech-learning-and-projects" target="_blank" rel="noopener">GitHub ↗</a></li>
      </ul>
    </nav>
    <main id="main"><slot /></main>
    <footer>
      <p>© {new Date().getFullYear()} Walter's Tech Blog · Powered by Astro</p>
      <p style="margin-top:8px;font-size:12px;color:var(--text-tertiary)">
        👀 本页访问 <span id="busuanzi_value_page_pv">--</span> 次 · 全站访客 <span id="busuanzi_value_site_uv">--</span> 人
      </p>
    </footer>
    <BackToTop />
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

# ============ PostLayout：挂 PostEnhance ============
cat > src/layouts/PostLayout.astro <<'ASTRO'
---
import BaseLayout from './BaseLayout.astro';
import PostEnhance from '@/components/PostEnhance.astro';

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
  <PostEnhance />
  <script is:inline>
    (function () {
      const slug = location.pathname.replace(/^.*\/posts\//, '').replace(/\/$/, '');
      const container = document.getElementById('comments');
      if (!container) return;
      container.innerHTML = '<h3 style="margin-bottom: 12px; color: var(--text-primary)">💬 评论</h3>';
      const s = document.createElement('script');
      s.src = 'https://giscus.app/client.js';
      s.setAttribute('data-repo', 'walterwang0x01/portfolio');
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

# ============ 老 URL 兼容：briefing.html 重定向到 /briefing/ ============
cat > public/briefing.html <<'HTML'
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>跳转中…</title>
  <meta http-equiv="refresh" content="0; url=./briefing/" />
  <link rel="canonical" href="./briefing/" />
</head>
<body>
  <p>正在跳转到新的 <a href="./briefing/">每日简报</a>…</p>
</body>
</html>
HTML

# kiro-sharing.html 原样搬过来（独立分享页）
if [ -f ../kiro-sharing.html ]; then
  cp ../kiro-sharing.html public/kiro-sharing.html
fi

# ============ 阶段 4：GitHub Actions workflow ============
cat > ../.github/workflows/deploy.yml <<'YML'
name: Deploy Astro to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: astro-site
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: astro-site/package-lock.json
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: astro-site/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
YML

echo "✅ 阶段 3+4 落盘完成"
