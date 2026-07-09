#!/usr/bin/env node
/**
 * 构建期同步简报 → public/briefings/
 *
 * 生产最佳实践：浏览器只读同源静态文件，不在运行时访问 GitHub API / raw.githubusercontent。
 * 数据源优先级：
 *   1. BRIEFINGS_SRC 或同级 tech-learning-and-projects 本地目录（CI checkout）
 *   2. jsDelivr CDN（本地开发 / 无 checkout 时的 fallback）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOPICS = ['ai-agent', 'china-tech', 'global-tech'];
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MONTHS_BACK = 3;
const REPO = 'walterwang0x01/tech-learning-and-projects';
const BRANCH = 'main';
const JSDELIVR = `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/learning-notes/briefings`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'briefings');

const LOCAL_CANDIDATES = [
  process.env.BRIEFINGS_SRC,
  path.resolve(ROOT, '../../tech-learning-and-projects/learning-notes/briefings'),
].filter(Boolean);

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function recentYearMonths() {
  const now = new Date();
  const pairs = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    pairs.push([d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0')]);
  }
  return pairs;
}

function copyFromLocal(srcRoot) {
  const manifest = Object.fromEntries(TOPICS.map((t) => [t, []]));
  let copied = 0;
  const allowed = new Set(
    recentYearMonths().map(([y, m]) => `${y}/${m}`),
  );

  for (const topic of TOPICS) {
    const topicDir = path.join(srcRoot, topic);
    if (!fs.existsSync(topicDir)) continue;

    for (const year of fs.readdirSync(topicDir)) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearDir = path.join(topicDir, year);
      for (const month of fs.readdirSync(yearDir)) {
        if (!/^\d{2}$/.test(month)) continue;
        if (!allowed.has(`${year}/${month}`)) continue;
        const monthDir = path.join(yearDir, month);
        for (const file of fs.readdirSync(monthDir)) {
          const m = file.match(DATE_RE);
          if (!m) continue;
          const date = m[1];
          const rel = `${topic}/${year}/${month}/${file}`;
          const dest = path.join(OUT, rel);
          ensureDir(path.dirname(dest));
          fs.copyFileSync(path.join(monthDir, file), dest);
          manifest[topic].push(date);
          copied += 1;
        }
      }
    }
    manifest[topic].sort((a, b) => b.localeCompare(a));
  }

  return { manifest, copied, source: srcRoot };
}

async function fetchText(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'portfolio-briefing-sync/1.0' },
      });
      if (resp.ok) return resp.text();
      lastErr = new Error(`${resp.status} ${resp.statusText}`);
      if (resp.status === 404) throw lastErr;
      if (resp.status === 429) await sleep(2000 * (i + 1));
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function listDatesFromGitHubApi(topic, year, month) {
  const url = `https://api.github.com/repos/${REPO}/contents/learning-notes/briefings/${topic}/${year}/${month}`;
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'portfolio-briefing-sync/1.0',
    },
  });
  if (resp.status === 404) return [];
  if (!resp.ok) throw new Error(`GitHub API ${topic}/${year}/${month}: ${resp.status}`);
  const files = await resp.json();
  return files
    .map((f) => f.name.match(DATE_RE)?.[1])
    .filter(Boolean);
}

async function syncFromRemote() {
  const manifest = Object.fromEntries(TOPICS.map((t) => [t, []]));
  let copied = 0;
  const localSrc = findLocalSource();

  for (const topic of TOPICS) {
    for (const [year, month] of recentYearMonths()) {
      let dates = [];
      try {
        dates = await listDatesFromGitHubApi(topic, year, month);
      } catch (e) {
        console.warn(`  ⚠️  列目录失败 ${topic}/${year}/${month}: ${e.message}`);
        continue;
      }

      for (const date of dates) {
        const rel = `${topic}/${year}/${month}/${date}.md`;
        const dest = path.join(OUT, rel);
        ensureDir(path.dirname(dest));

        if (localSrc) {
          const localFile = path.join(localSrc, rel);
          if (fs.existsSync(localFile)) {
            fs.copyFileSync(localFile, dest);
            manifest[topic].push(date);
            copied += 1;
            continue;
          }
        }

        const url = `${JSDELIVR}/${rel}`;
        try {
          const md = await fetchText(url);
          fs.writeFileSync(dest, md, 'utf8');
          manifest[topic].push(date);
          copied += 1;
        } catch (e) {
          console.warn(`  ⚠️  跳过 ${rel}: ${e.message}`);
        }
      }
    }
    manifest[topic].sort((a, b) => b.localeCompare(a));
  }

  return { manifest, copied, source: localSrc ? `local+jsdelivr (${localSrc})` : 'jsdelivr' };
}

function findLocalSource() {
  for (const p of LOCAL_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function writeManifest(manifest, meta) {
  const payload = {
    generatedAt: new Date().toISOString(),
    source: meta.source,
    topics: manifest,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(payload, null, 2), 'utf8');
}

async function main() {
  console.log('📰 同步简报到 public/briefings/ …');
  rmrf(OUT);
  ensureDir(OUT);

  const local = findLocalSource();
  let result;

  if (local) {
    console.log(`  📂 本地源: ${local}`);
    result = copyFromLocal(local);
    if (result.copied === 0) {
      console.log('  ⚠️  本地源无近 3 个月文件，回退远程拉取');
      result = await syncFromRemote();
    }
  } else {
    console.log('  🌐 无本地源，使用 GitHub API + jsDelivr');
    result = await syncFromRemote();
  }

  writeManifest(result.manifest, { source: result.source });

  const totalDates = TOPICS.reduce((n, t) => n + result.manifest[t].length, 0);
  console.log(`  ✅ 已同步 ${result.copied} 个文件，${totalDates} 个日期条目`);
  for (const t of TOPICS) {
    const n = result.manifest[t].length;
    const latest = result.manifest[t][0] ?? '—';
    console.log(`     ${t}: ${n} 篇，最新 ${latest}`);
  }
}

main().catch((e) => {
  console.error('❌ 简报同步失败:', e);
  process.exit(1);
});
