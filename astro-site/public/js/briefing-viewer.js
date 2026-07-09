/**
 * 简报阅读器 — 只读同源 /briefings/ 静态资源（构建期 sync-briefings.mjs 产出）
 */
(function initBriefingViewer(global) {
  'use strict';

  const TOPICS = ['ai-agent', 'china-tech', 'global-tech'];

  function createViewer(options) {
    const briefingsBase = options.briefingsBase.replace(/\/?$/, '/');
    const tabs = document.getElementById(options.tabsId || 'topicTabs');
    const dateList = document.getElementById(options.dateListId || 'dateList');
    const content = document.getElementById(options.contentId || 'briefingContent');
    const dateLimit = options.dateLimit ?? 14;

    let topic = 'ai-agent';
    let date = null;
    let manifest = null;
    const contentCache = {};

    function parseHash() {
      const h = global.location.hash.slice(1);
      if (!h) return null;
      const [t, d] = h.split('/');
      if (t && TOPICS.includes(t)) return { topic: t, date: d || null };
      return null;
    }

    function updateHash(t, d) {
      const h = d ? `${t}/${d}` : t;
      const target = `#${h}`;
      if (global.location.hash !== target) {
        global.history.replaceState(null, '', target);
      }
    }

    function setActive(container, attr, value) {
      container.querySelectorAll(`button[${attr}]`).forEach((b) => {
        b.classList.toggle('active', b.getAttribute(attr) === value);
      });
    }

    function showLoading(msg) {
      content.innerHTML = `<div class="empty">${msg || '加载中…'}</div>`;
    }

    function showError(msg, detail) {
      content.innerHTML = `<div class="empty">😕 ${msg}${detail ? `<br><small>${detail}</small>` : ''}</div>`;
    }

    async function loadManifest() {
      if (manifest) return manifest;
      const resp = await fetch(`${briefingsBase}manifest.json`, { cache: 'no-cache' });
      if (!resp.ok) throw new Error(`manifest HTTP ${resp.status}`);
      const data = await resp.json();
      manifest = data.topics || data;
      return manifest;
    }

    async function fetchContent(t, d) {
      const key = `${t}/${d}`;
      if (contentCache[key]) return contentCache[key];
      const [y, mo] = d.split('-');
      const url = `${briefingsBase}${t}/${y}/${mo}/${d}.md`;
      const resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const md = await resp.text();
      contentCache[key] = md;
      return md;
    }

    function renderMarkdown(md) {
      md = md.replace(/<!--[\s\S]*?-->/g, '').replace(/^---[\s\S]*?---\n*/m, '');
      return global.marked.parse(md, { breaks: true, gfm: true });
    }

    async function load(t, d) {
      date = d;
      updateHash(t, d);
      setActive(dateList, 'data-date', d);
      showLoading('加载简报…');
      try {
        const md = await fetchContent(t, d);
        content.innerHTML = renderMarkdown(md);
      } catch (e) {
        showError('加载失败，请稍后重试', e.message);
      }
    }

    function renderDates(dates, activeDate) {
      dateList.innerHTML = dates.slice(0, dateLimit).map((x) =>
        `<button type="button" class="badge${x === activeDate ? ' active' : ''}" data-date="${x}">${x.slice(5)}</button>`,
      ).join('');
    }

    async function switchTopic(t) {
      topic = t;
      setActive(tabs, 'data-topic', t);
      showLoading('加载日期列表…');
      try {
        const m = await loadManifest();
        const dates = (m[t] || []).slice();
        if (!dates.length) {
          dateList.innerHTML = '';
          showError('暂无简报数据');
          updateHash(t, null);
          return;
        }
        const target = date && dates.includes(date) ? date : dates[0];
        renderDates(dates, target);
        await load(t, target);
      } catch (e) {
        showError('加载失败', e.message);
      }
    }

    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-topic]');
      if (b) {
        date = null;
        switchTopic(b.dataset.topic);
      }
    });

    dateList.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-date]');
      if (b) load(topic, b.dataset.date);
    });

    global.addEventListener('hashchange', () => {
      const s = parseHash();
      if (s && (s.topic !== topic || s.date !== date)) {
        date = s.date;
        switchTopic(s.topic);
      }
    });

    const initial = parseHash();
    if (initial) {
      topic = initial.topic;
      date = initial.date;
    }
    switchTopic(topic);
  }

  global.BriefingViewer = { create: createViewer };
})(window);
