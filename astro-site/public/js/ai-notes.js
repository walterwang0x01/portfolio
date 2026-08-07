/**
 * AI 知识库交互逻辑
 * 三个视图：路线图（roadmap）/ 阅读（read）/ 自测（quiz）
 * 进度存 localStorage：已读篇目 + 自测掌握度
 */
(function () {
  'use strict';

  const STORE_KEY = 'ai-notes-progress-v1';

  const state = {
    base: '',
    manifest: null,
    quiz: null,
    view: 'roadmap',
    progress: { read: {}, quiz: {} },   // read: {file: ts}, quiz: {"file#idx": "got"|"vague"|"lost"}
    quizFilter: 'all',
    quizIndex: 0,
    quizDeck: [],
  };

  /* ---------------- 进度持久化 ---------------- */

  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        state.progress = { read: p.read || {}, quiz: p.quiz || {} };
      }
    } catch (e) {
      /* 存储不可用时静默降级，不影响浏览 */
    }
  }

  function saveProgress() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.progress));
    } catch (e) {
      /* 隐私模式下 localStorage 可能抛异常，忽略 */
    }
  }

  function markRead(file) {
    state.progress.read[file] = Date.now();
    saveProgress();
  }

  /* ---------------- 工具 ---------------- */

  const prettify = (s) => s.replace(/\.md$/, '').replace(/^\d+[-.]?\s*/, '');

  /** 该笔记是否内嵌了可视化 demo（从 AIDemos 注册表反查） */
  function demoOf(file) {
    if (!window.AIDemos) return null;
    for (const t of window.AIDemos.types()) {
      if (window.AIDemos.meta(t).note === file) return t;
    }
    return null;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtMinutes(min) {
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
  }

  function $(sel) { return document.querySelector(sel); }

  /* ---------------- 视图切换 ---------------- */

  function switchView(view, opts = {}) {
    state.view = view;
    for (const v of ['roadmap', 'read', 'quiz']) {
      const panel = $(`#view-${v}`);
      if (panel) panel.hidden = v !== view;
      const tab = $(`[data-view-tab="${v}"]`);
      if (tab) tab.classList.toggle('active', v === view);
    }
    if (view === 'roadmap') renderRoadmap();
    if (view === 'quiz') renderQuiz();
    if (view === 'read' && opts.file) loadNote(opts.file);

    const hash = view === 'read' && opts.file
      ? `#read/${encodeURIComponent(opts.file)}`
      : `#${view}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  /* ---------------- 视图一：路线图 ---------------- */

  function renderRoadmap() {
    const el = $('#roadmapBody');
    if (!el || !state.manifest) return;

    const { roadmap, count, quizTotal } = state.manifest;
    const readTotal = Object.keys(state.progress.read).length;
    const quizDone = Object.keys(state.progress.quiz).length;

    let html = `
      <div class="stats-row">
        <div class="stat"><b>${count}</b><span>篇笔记</span></div>
        <div class="stat"><b>${quizTotal}</b><span>道自测题</span></div>
        <div class="stat accent"><b>${readTotal}</b><span>已读</span></div>
        <div class="stat accent"><b>${quizDone}</b><span>已自测</span></div>
      </div>
      <p class="roadmap-hint">按依赖关系编号，建议顺序阅读 · 点击阶段展开篇目</p>
      <ol class="roadmap">`;

    roadmap.forEach((stage, i) => {
      const readCount = stage.files.filter((f) => state.progress.read[f]).length;
      const pct = stage.notes ? Math.round((readCount / stage.notes) * 100) : 0;
      html += `
        <li class="stage" data-stage="${esc(stage.id)}">
          <div class="stage-head" role="button" tabindex="0" aria-expanded="false">
            <div class="stage-index">
              <span class="stage-emoji">${stage.emoji}</span>
              <span class="stage-num">${String(i).padStart(2, '0')}</span>
            </div>
            <div class="stage-main">
              <div class="stage-titlebar">
                <span class="stage-title">${esc(stage.label)}</span>
                <span class="stage-meta">
                  <span>${stage.notes} 篇</span><span>${stage.quizCount} 题</span><span>${fmtMinutes(stage.minutes)}</span>
                </span>
              </div>
              <div class="stage-tagline">${esc(stage.tagline)}</div>
              <div class="stage-why">${esc(stage.why)}</div>
              <div class="stage-progress">
                <div class="progress-bar"><i style="width:${pct}%"></i></div>
                <div class="progress-text">${readCount} / ${stage.notes} 已读 · ${pct}%</div>
              </div>
            </div>
            <span class="stage-caret">›</span>
          </div>
          <ul class="stage-files" hidden></ul>
        </li>`;
      if (i < roadmap.length - 1) html += '<li class="stage-arrow">↓</li>';
    });

    html += `</ol>
      <div class="roadmap-note">
        <b>数学基础是按需查阅的参考资料</b>，不要试图先读完
        <code>01-machine-learning/00-数学基础/</code> 再往下走。遇到公式看不懂时回来翻对应章节即可。
      </div>`;

    el.innerHTML = html;

    // 展开/收起阶段篇目
    el.querySelectorAll('.stage-head').forEach((head) => {
      const toggle = () => {
        const li = head.closest('.stage');
        const ul = li.querySelector('.stage-files');
        const stage = state.manifest.roadmap.find((s) => s.id === li.dataset.stage);
        if (!ul.dataset.filled) {
          ul.innerHTML = stage.files.map((f) => {
            const done = state.progress.read[f] ? ' done' : '';
            const parts = f.split('/');
            const sub = parts.length > 2 ? prettify(parts[1]) + ' /' : '';
            const hasDemo = demoOf(f) ? ' has-demo' : '';
            return `<li><a href="#read/${encodeURIComponent(f)}" class="file-link${done}" data-file="${esc(f)}">
              <span class="file-check">${state.progress.read[f] ? '✓' : '○'}</span>
              <span class="${hasDemo}"><span class="file-sub">${esc(sub)}</span>${esc(prettify(parts[parts.length - 1]))}</span>
            </a></li>`;
          }).join('');
          ul.dataset.filled = '1';
        }
        const nowOpen = ul.hidden;
        ul.hidden = !nowOpen;
        li.classList.toggle('open', nowOpen);
        head.setAttribute('aria-expanded', String(nowOpen));
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    el.addEventListener('click', (e) => {
      const link = e.target.closest('.file-link');
      if (link) {
        e.preventDefault();
        switchView('read', { file: link.dataset.file });
      }
    });
  }

  /* ---------------- 视图二：阅读 ---------------- */

  function renderTree(children, container) {
    container.innerHTML = '';
    for (const node of children) {
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = prettify(node.name.split('/').pop());
      details.appendChild(summary);

      if (node.files && node.files.length) {
        const ul = document.createElement('ul');
        for (const f of node.files) {
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.href = `#read/${encodeURIComponent(f)}`;
          a.textContent = prettify(f.split('/').pop());
          a.dataset.file = f;
          if (state.progress.read[f]) a.classList.add('done');
          if (demoOf(f)) a.classList.add('has-demo');
          a.addEventListener('click', (e) => {
            e.preventDefault();
            loadNote(f);
            $('#notesSidebar')?.classList.remove('open');
          });
          li.appendChild(a);
          ul.appendChild(li);
        }
        details.appendChild(ul);
      }

      if (node.children && node.children.length) {
        const holder = document.createElement('div');
        renderTree(node.children, holder);
        while (holder.firstChild) details.appendChild(holder.firstChild);
      }
      container.appendChild(details);
    }
  }

  async function loadNote(file) {
    switchView('read');
    const content = $('#notesContent');
    content.innerHTML = '<div class="loading">加载中…</div>';
    window.MdEnhance?.teardown();
    try {
      const resp = await fetch(state.base + file);
      if (!resp.ok) throw new Error(resp.statusText);
      const md = await resp.text();
      const html = window.marked ? window.marked.parse(md) : `<pre>${esc(md)}</pre>`;
      const quizItem = state.quiz?.items.find((it) => it.file === file);
      const minutes = window.MdEnhance?.estimateMinutes(md) ?? 0;

      content.innerHTML = `
        <div class="read-progress"><i id="readProgressBar"></i></div>
        <div class="note-actions">
          <button id="markReadBtn" class="btn-primary">
            ${state.progress.read[file] ? '✓ 已标记为读完' : '标记为读完'}
          </button>
          ${quizItem ? `<button id="jumpQuizBtn" class="btn-ghost">去自测这篇（${quizItem.questions.length} 题）</button>` : ''}
          <a class="btn-ghost" target="_blank" rel="noopener"
             href="https://github.com/walterwang0x01/tech-learning-and-projects/blob/main/learning-notes/00-ai/${file.split('/').map(encodeURIComponent).join('/')}">在 GitHub 查看 ↗</a>
          <span class="read-meta" id="readMeta">约 ${minutes} 分钟读完</span>
        </div>
        <div class="note-body">
          <div class="note-md" id="noteMd">${html}</div>
          <aside class="toc-float" id="tocFloat" hidden></aside>
        </div>`;
      window.scrollTo({ top: 0, behavior: 'smooth' });

      // markdown 增强：公式 / 代码高亮 / mermaid / TOC / 进度条
      const mdRoot = $('#noteMd');
      await window.MdEnhance?.enhance(mdRoot, {
        md,
        tocMount: $('#tocFloat'),
        progressBar: $('#readProgressBar'),
        progressMeta: $('#readMeta'),
      });

      // 内嵌可视化 demo（笔记里的 <!-- demo:xxx --> 标记）
      mountInlineDemos(mdRoot);

      $('#markReadBtn')?.addEventListener('click', (e) => {
        markRead(file);
        e.target.textContent = '✓ 已标记为读完';
        document.querySelectorAll(`a[data-file="${CSS.escape(file)}"]`).forEach((a) => a.classList.add('done'));
      });
      $('#jumpQuizBtn')?.addEventListener('click', () => {
        state.quizFilter = file;
        switchView('quiz');
      });

      // 高亮侧栏当前项 + 展开父级
      document.querySelectorAll('#notesTree a.active').forEach((a) => a.classList.remove('active'));
      const cur = document.querySelector(`#notesTree a[data-file="${CSS.escape(file)}"]`);
      if (cur) {
        cur.classList.add('active');
        let p = cur.parentElement;
        while (p) { if (p.tagName === 'DETAILS') p.open = true; p = p.parentElement; }
      }
      history.replaceState(null, '', `#read/${encodeURIComponent(file)}`);
    } catch (err) {
      content.innerHTML = `<div class="error">加载失败：${esc(err.message)}</div>`;
    }
  }

  /**
   * 处理笔记里的 <!-- demo:xxx --> 标记，替换成可折叠的交互演示
   * marked 会把 HTML 注释原样输出到 DOM，用 TreeWalker 找出来
   */
  function mountInlineDemos(root) {
    if (!window.AIDemos) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const marks = [];
    let node;
    while ((node = walker.nextNode())) {
      const m = (node.nodeValue || '').trim().match(/^demo:([a-z]+)$/);
      if (m && window.AIDemos.has(m[1])) marks.push({ node, type: m[1] });
    }

    marks.forEach(({ node, type }, i) => {
      const meta = window.AIDemos.meta(type);
      const box = document.createElement('div');
      box.className = 'inline-demo';
      box.innerHTML = `
        <button class="inline-demo-toggle" type="button">
          <span class="idt-icon">🔬</span>
          <span class="idt-text">展开交互演示：${escapeHtml(meta.title)}</span>
          <span class="idt-caret">›</span>
        </button>
        <div class="inline-demo-body" hidden></div>`;
      node.parentNode.replaceChild(box, node);

      const btn = box.querySelector('.inline-demo-toggle');
      const body = box.querySelector('.inline-demo-body');
      let mounted = false;

      btn.addEventListener('click', () => {
        const willOpen = body.hidden;
        body.hidden = !willOpen;
        box.classList.toggle('open', willOpen);
        btn.querySelector('.idt-text').textContent =
          (willOpen ? '收起交互演示：' : '展开交互演示：') + meta.title;
        if (willOpen && !mounted) {
          window.AIDemos.mount(type, body, { compact: true, idPrefix: `inline-${type}-${i}` });
          mounted = true;
        }
      });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------- 视图三：自测 ---------------- */

  function buildDeck() {
    const items = state.quiz?.items ?? [];
    const pool = state.quizFilter === 'all'
      ? items
      : state.quizFilter.endsWith('.md')
        ? items.filter((it) => it.file === state.quizFilter)
        : items.filter((it) => it.module === state.quizFilter);

    const deck = [];
    for (const it of pool) {
      it.questions.forEach((q, idx) => {
        deck.push({ key: `${it.file}#${idx}`, question: q, file: it.file, title: it.title, moduleLabel: it.moduleLabel, section: it.section });
      });
    }
    return deck;
  }

  function renderQuiz() {
    const el = $('#quizBody');
    if (!el || !state.quiz) return;

    state.quizDeck = buildDeck();
    if (state.quizIndex >= state.quizDeck.length) state.quizIndex = 0;

    const modules = state.manifest.roadmap.filter((s) => s.quizCount > 0);
    const graded = state.quizDeck.filter((c) => state.progress.quiz[c.key]);
    const got = state.quizDeck.filter((c) => state.progress.quiz[c.key] === 'got').length;

    const filterLabel = state.quizFilter.endsWith('.md')
      ? prettify(state.quizFilter.split('/').pop())
      : null;

    el.innerHTML = `
      <div class="quiz-toolbar">
        <div class="quiz-filters">
          <button class="chip ${state.quizFilter === 'all' ? 'active' : ''}" data-qf="all">全部 ${state.quiz.total}</button>
          ${modules.map((m) => `<button class="chip ${state.quizFilter === m.id ? 'active' : ''}" data-qf="${esc(m.id)}">${m.emoji} ${esc(m.label)} ${m.quizCount}</button>`).join('')}
          ${filterLabel ? `<button class="chip active" data-qf="all">单篇：${esc(filterLabel)} ✕</button>` : ''}
        </div>
        <div class="quiz-progress">已测 ${graded.length}/${state.quizDeck.length} · 掌握 ${got}</div>
      </div>
      <div id="quizCard"></div>`;

    el.querySelectorAll('[data-qf]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.quizFilter = btn.dataset.qf;
        state.quizIndex = 0;
        renderQuiz();
      });
    });

    renderCard();
  }

  function renderCard() {
    const host = $('#quizCard');
    if (!host) return;
    const deck = state.quizDeck;

    if (deck.length === 0) {
      host.innerHTML = '<div class="empty">该范围暂无自测题</div>';
      return;
    }

    const card = deck[state.quizIndex];
    const grade = state.progress.quiz[card.key];

    host.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-source">
          ${esc(card.moduleLabel)}${card.section ? ' / ' + esc(card.section) : ''} · ${esc(card.title)}
        </div>
        <div class="quiz-q">${esc(card.question)}</div>
        <div class="quiz-tip">先在心里（或纸上）回答，再看原文对照。答不上就是需要精读的信号。</div>
        <div class="quiz-actions">
          <button class="btn-primary" id="revealBtn">对照原文</button>
          <a class="btn-ghost" href="#read/${encodeURIComponent(card.file)}" id="openNoteBtn">打开全文</a>
        </div>
        <div class="quiz-grade">
          <span>自评：</span>
          <button class="grade ${grade === 'got' ? 'on' : ''}" data-g="got">✅ 答得上</button>
          <button class="grade ${grade === 'vague' ? 'on' : ''}" data-g="vague">🤔 模糊</button>
          <button class="grade ${grade === 'lost' ? 'on' : ''}" data-g="lost">❌ 答不上</button>
        </div>
        <div class="quiz-nav">
          <button class="btn-ghost" id="prevBtn" ${state.quizIndex === 0 ? 'disabled' : ''}>← 上一题</button>
          <span class="quiz-counter">${state.quizIndex + 1} / ${deck.length}</span>
          <button class="btn-ghost" id="nextBtn" ${state.quizIndex >= deck.length - 1 ? 'disabled' : ''}>下一题 →</button>
        </div>
      </div>`;

    $('#revealBtn').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = '加载中…';
      try {
        const resp = await fetch(state.base + card.file);
        const md = await resp.text();
        // 截掉 blockquote 里的三个问题，只展示正文
        const bodyStart = md.indexOf('\n## ');
        const body = bodyStart > -1 ? md.slice(bodyStart) : md;
        const html = window.marked ? window.marked.parse(body) : `<pre>${esc(body)}</pre>`;
        const box = document.createElement('div');
        box.className = 'quiz-reveal post-body';
        box.innerHTML = html;
        e.target.closest('.quiz-actions').after(box);
        e.target.remove();
      } catch (err) {
        e.target.textContent = '加载失败，重试';
        e.target.disabled = false;
      }
    });

    host.querySelectorAll('.grade').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.progress.quiz[card.key] = btn.dataset.g;
        saveProgress();
        renderQuiz();
      });
    });

    $('#prevBtn').addEventListener('click', () => { state.quizIndex--; renderCard(); });
    $('#nextBtn').addEventListener('click', () => { state.quizIndex++; renderCard(); });
    $('#openNoteBtn').addEventListener('click', (e) => {
      e.preventDefault();
      switchView('read', { file: card.file });
    });
  }

  /* ---------------- 初始化 ---------------- */

  async function init(opts) {
    state.base = opts.notesBase;
    loadProgress();

    const [manifest, quiz] = await Promise.all([
      fetch(state.base + 'manifest.json').then((r) => r.json()),
      fetch(state.base + 'quiz.json').then((r) => r.json()).catch(() => ({ total: 0, items: [] })),
    ]);
    state.manifest = manifest;
    state.quiz = quiz;

    renderTree(manifest.tree.children, $('#notesTree'));

    document.querySelectorAll('[data-view-tab]').forEach((tab) => {
      tab.addEventListener('click', () => switchView(tab.dataset.viewTab));
    });
    $('#sidebarToggle')?.addEventListener('click', () => $('#notesSidebar').classList.add('open'));
    $('#sidebarClose')?.addEventListener('click', () => $('#notesSidebar').classList.remove('open'));

    $('#notesSearch')?.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('#notesTree a').forEach((a) => {
        const hit = !q || a.textContent.toLowerCase().includes(q);
        a.closest('li').style.display = hit ? '' : 'none';
      });
      if (q) document.querySelectorAll('#notesTree details').forEach((d) => (d.open = true));
    });

    applyHash();
    window.addEventListener('hashchange', applyHash);
  }

  function applyHash() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('read/')) {
      loadNote(h.slice(5));
    } else if (h === 'quiz') {
      switchView('quiz');
    } else {
      switchView('roadmap');
    }
  }

  window.AINotes = { init };
})();
