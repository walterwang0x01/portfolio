/**
 * Markdown 阅读增强
 * 负责：KaTeX 公式 / 代码高亮+复制 / 浮动 TOC / 阅读进度 / Mermaid
 *
 * 设计要点：
 * - 所有第三方库按需懒加载（CDN 版本已 pin），只有笔记真的用到才加载
 * - KaTeX 必须排除 pre/code，否则笔记里的 shell 变量（$DOC_DIR）会被当公式
 * - 主题跟随站点：监听 html[data-theme] 变化
 */
(function () {
  'use strict';

  const CDN = {
    katexCss: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
    katexJs: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
    katexAuto: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js',
    hljsJs: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js',
    hljsLight: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github.min.css',
    hljsDark: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github-dark.min.css',
    mermaid: 'https://cdn.jsdelivr.net/npm/mermaid@11.4.0/dist/mermaid.esm.min.mjs',
  };

  const loaded = new Set();

  function loadCss(url, id) {
    if (loaded.has(url)) return Promise.resolve();
    loaded.add(url);
    return new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = url;
      if (id) link.id = id;
      link.onload = link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  function loadJs(url) {
    if (loaded.has(url)) return Promise.resolve();
    loaded.add(url);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('加载失败: ' + url));
      document.head.appendChild(s);
    });
  }

  const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

  /* ==================== KaTeX ==================== */

  async function renderMath(root) {
    // 快速判断是否需要：有 $...$ 或 \(...\) 才加载库
    const text = root.textContent || '';
    if (!/\$[^$\n]+\$|\$\$|\\\(|\\\[/.test(text)) return;

    try {
      await loadCss(CDN.katexCss);
      await loadJs(CDN.katexJs);
      await loadJs(CDN.katexAuto);
      if (!window.renderMathInElement) return;

      window.renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        // 关键：排除代码相关标签
        // 笔记里有大量 shell 变量（$DOC_DIR、$HOME）和代码里的 $，
        // 不排除会被当成公式起始符，把整段代码吞掉
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option'],
        ignoredClasses: ['no-katex'],
        throwOnError: false,
        errorColor: '#cc4444',
      });
    } catch (e) {
      console.warn('[md-enhance] KaTeX 加载失败，公式将显示为原文', e);
    }
  }

  /* ==================== 代码高亮 + 复制 ==================== */

  let hljsThemeLink = null;

  async function syncHljsTheme() {
    const url = isDark() ? CDN.hljsDark : CDN.hljsLight;
    if (!hljsThemeLink) {
      hljsThemeLink = document.createElement('link');
      hljsThemeLink.rel = 'stylesheet';
      hljsThemeLink.id = 'hljs-theme';
      document.head.appendChild(hljsThemeLink);
    }
    if (hljsThemeLink.href !== url) hljsThemeLink.href = url;
  }

  async function highlightCode(root) {
    const blocks = root.querySelectorAll('pre > code');
    if (blocks.length === 0) return;

    try {
      await syncHljsTheme();
      await loadJs(CDN.hljsJs);
      if (!window.hljs) return;

      blocks.forEach((code) => {
        const pre = code.parentElement;
        if (pre.dataset.enhanced) return;
        pre.dataset.enhanced = '1';

        // 语言：marked 输出 class="language-xxx"
        const m = (code.className || '').match(/language-([\w+-]+)/);
        const lang = m ? m[1] : '';

        // 只对已知语言高亮。ASCII 图表/流程图没有语言标记，
        // 强行 autodetect 会把它们染成一片乱色
        if (lang && window.hljs.getLanguage(lang)) {
          try { window.hljs.highlightElement(code); } catch (e) { /* 单块失败不影响其他 */ }
        } else {
          code.classList.add('no-highlight');
        }

        // 包一层用于定位工具条
        const wrap = document.createElement('div');
        wrap.className = 'code-block';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);

        const bar = document.createElement('div');
        bar.className = 'code-bar';
        bar.innerHTML = `
          <span class="code-lang">${lang || 'text'}</span>
          <button class="code-copy" type="button" aria-label="复制代码">复制</button>`;
        wrap.insertBefore(bar, pre);

        bar.querySelector('.code-copy').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          try {
            await navigator.clipboard.writeText(code.textContent);
            btn.textContent = '✓ 已复制';
            btn.classList.add('copied');
          } catch (err) {
            // clipboard API 在非 HTTPS 或权限受限时不可用，退回选中文本
            const range = document.createRange();
            range.selectNodeContents(code);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            btn.textContent = '已选中，按 ⌘C';
          }
          setTimeout(() => {
            btn.textContent = '复制';
            btn.classList.remove('copied');
          }, 2000);
        });
      });
    } catch (e) {
      console.warn('[md-enhance] 代码高亮加载失败', e);
    }
  }

  /* ==================== Mermaid ==================== */

  async function renderMermaid(root) {
    // marked 会把 ```mermaid 渲染成 <pre><code class="language-mermaid">
    const blocks = Array.from(root.querySelectorAll('code.language-mermaid'));
    if (blocks.length === 0) return;

    try {
      const mod = await import(/* @vite-ignore */ CDN.mermaid);
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark() ? 'dark' : 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit',
      });

      for (let i = 0; i < blocks.length; i++) {
        const code = blocks[i];
        const src = code.textContent;
        const host = document.createElement('div');
        host.className = 'mermaid-figure';
        try {
          const { svg } = await mermaid.render(`mmd-${Date.now()}-${i}`, src);
          host.innerHTML = svg;
          // 替换掉外层的 code-block 或 pre
          const target = code.closest('.code-block') || code.parentElement;
          target.parentNode.replaceChild(host, target);
        } catch (err) {
          console.warn('[md-enhance] mermaid 渲染失败，保留源码', err);
        }
      }
    } catch (e) {
      console.warn('[md-enhance] mermaid 加载失败', e);
    }
  }

  /* ==================== 浮动 TOC ==================== */

  let tocObserver = null;

  function buildToc(root, mount) {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    mount.innerHTML = '';

    const heads = Array.from(root.querySelectorAll('h2, h3'))
      .filter((h) => (h.textContent || '').trim());
    if (heads.length < 3) { mount.hidden = true; return; }
    mount.hidden = false;

    // 给每个标题生成稳定 id
    heads.forEach((h, i) => {
      if (!h.id) h.id = 'sec-' + i + '-' + (h.textContent.trim().slice(0, 20).replace(/[^\w\u4e00-\u9fa5]+/g, '-'));
    });

    mount.innerHTML = `
      <div class="toc-title">本页目录</div>
      <ul class="toc-list">
        ${heads.map((h) => `
          <li class="toc-item toc-${h.tagName.toLowerCase()}">
            <a href="#${h.id}" data-target="${h.id}">${escHtml(h.textContent.trim())}</a>
          </li>`).join('')}
      </ul>`;

    const links = new Map();
    mount.querySelectorAll('a[data-target]').forEach((a) => {
      links.set(a.dataset.target, a);
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const el = document.getElementById(a.dataset.target);
        if (el) {
          const top = el.getBoundingClientRect().top + window.scrollY - 84;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      });
    });

    // 高亮当前章节：取所有已进入视口上方的标题中最后一个
    const setActive = (id) => {
      links.forEach((a, key) => a.classList.toggle('active', key === id));
      const active = links.get(id);
      if (active) {
        const box = mount.querySelector('.toc-list');
        const aTop = active.offsetTop;
        if (aTop < box.scrollTop || aTop > box.scrollTop + box.clientHeight - 40) {
          box.scrollTop = aTop - box.clientHeight / 2;
        }
      }
    };

    tocObserver = new IntersectionObserver(
      () => {
        let current = heads[0]?.id;
        for (const h of heads) {
          if (h.getBoundingClientRect().top <= 100) current = h.id;
          else break;
        }
        if (current) setActive(current);
      },
      { rootMargin: '-90px 0px -70% 0px', threshold: [0, 1] },
    );
    heads.forEach((h) => tocObserver.observe(h));
    setActive(heads[0].id);
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ==================== 阅读进度 ==================== */

  let progressHandler = null;

  /** 估算阅读时长：中文按 500 字/分钟，排除代码块字数 */
  function estimateMinutes(md) {
    const noCode = md.replace(/```[\s\S]*?```/g, '');
    const cjk = (noCode.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (noCode.match(/[a-zA-Z]+/g) || []).length;
    return Math.max(1, Math.round(cjk / 500 + words / 220));
  }

  function mountProgress(bar, meta, totalMinutes) {
    if (progressHandler) window.removeEventListener('scroll', progressHandler);

    const update = () => {
      const doc = document.documentElement;
      const scrolled = window.scrollY;
      const total = doc.scrollHeight - window.innerHeight;
      const pct = total > 0 ? Math.min(100, Math.max(0, (scrolled / total) * 100)) : 0;
      bar.style.width = pct.toFixed(1) + '%';

      const remain = Math.max(0, Math.round(totalMinutes * (1 - pct / 100)));
      meta.textContent = pct >= 99
        ? `约 ${totalMinutes} 分钟读完 · 已读完`
        : `约 ${totalMinutes} 分钟读完 · 剩余 ${remain} 分钟`;
    };

    progressHandler = update;
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  /* ==================== 主题切换时重新适配 ==================== */

  function watchTheme() {
    new MutationObserver(() => {
      syncHljsTheme();
      // mermaid 主题变化需要重渲染，成本高且场景少，这里只提示
      const figs = document.querySelectorAll('.mermaid-figure');
      if (figs.length) figs.forEach((f) => f.classList.toggle('mmd-dark', isDark()));
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  /* ==================== 对外接口 ==================== */

  /**
   * 增强一段已渲染的 markdown HTML
   * @param {HTMLElement} root 渲染后的容器
   * @param {object} opts { md: 原始 markdown, tocMount: TOC 容器, progressBar, progressMeta }
   */
  async function enhance(root, opts = {}) {
    // 顺序有讲究：先高亮（会包一层 .code-block），再渲染 mermaid（要找 .code-block），
    // 最后跑 KaTeX（此时 pre/code 已定型，ignoredTags 才能准确排除）
    await highlightCode(root);
    await renderMermaid(root);
    await renderMath(root);

    if (opts.tocMount) buildToc(root, opts.tocMount);
    if (opts.progressBar && opts.progressMeta && opts.md) {
      mountProgress(opts.progressBar, opts.progressMeta, estimateMinutes(opts.md));
    }
  }

  function teardown() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    if (progressHandler) { window.removeEventListener('scroll', progressHandler); progressHandler = null; }
  }

  watchTheme();
  window.MdEnhance = { enhance, teardown, estimateMinutes };
})();
