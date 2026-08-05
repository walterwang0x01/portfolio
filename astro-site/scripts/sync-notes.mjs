#!/usr/bin/env node
/**
 * 构建期同步 AI 知识库 + 读书收藏 → public/notes/ 和 public/reading/
 *
 * 数据源：NOTES_SRC 环境变量 或同级 tech-learning-and-projects 本地目录
 * 排除：git-crypt 加密目录（20-Agent支付、24-2026技术更新）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_NOTES = path.join(ROOT, 'public', 'notes');
const OUT_READING = path.join(ROOT, 'public', 'reading');

// 加密目录，不能公开
const EXCLUDED_DIRS = [
  '04-ai-agent/20-Agent支付',
  '04-ai-agent/24-2026技术更新',
];

const LOCAL_CANDIDATES = [
  process.env.NOTES_SRC,
  path.resolve(ROOT, '../../tech-learning-and-projects'),
].filter(Boolean);

function findSource() {
  for (const p of LOCAL_CANDIDATES) {
    if (p && fs.existsSync(path.join(p, 'learning-notes/00-ai'))) return p;
  }
  return null;
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function isExcluded(relPath) {
  return EXCLUDED_DIRS.some((ex) => relPath.includes(ex));
}

function copyTree(srcDir, destDir, relBase = '') {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = path.join(relBase, entry.name);
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (isExcluded(rel)) continue;
      if (entry.name.startsWith('.')) continue;
      count += copyTree(src, dest, rel);
    } else if (entry.name.endsWith('.md')) {
      ensureDir(path.dirname(dest));
      fs.copyFileSync(src, dest);
      count += 1;
    }
  }
  return count;
}

function buildManifest(dir, relBase = '') {
  const tree = { name: relBase || 'root', children: [], files: [] };
  if (!fs.existsSync(dir)) return tree;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(relBase, entry.name);
    if (entry.isDirectory()) {
      tree.children.push(buildManifest(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md')) {
      tree.files.push(rel);
    }
  }
  return tree;
}

function main() {
  console.log('📚 同步 AI 知识库 + 读书收藏 …');

  const source = findSource();
  if (!source) {
    console.warn('  ⚠️  未找到 tech-learning-and-projects 源，跳过 notes 同步');
    // 写空 manifest 避免前端报错
    ensureDir(OUT_NOTES);
    fs.writeFileSync(path.join(OUT_NOTES, 'manifest.json'), JSON.stringify({ tree: { children: [], files: [] }, count: 0 }), 'utf8');
    ensureDir(OUT_READING);
    fs.writeFileSync(path.join(OUT_READING, 'manifest.json'), JSON.stringify({ books: [] }), 'utf8');
    return;
  }

  console.log(`  📂 源: ${source}`);

  // 1. 同步 00-ai/ → public/notes/
  rmrf(OUT_NOTES);
  ensureDir(OUT_NOTES);
  const notesCount = copyTree(path.join(source, 'learning-notes/00-ai'), OUT_NOTES);
  const notesTree = buildManifest(OUT_NOTES);
  fs.writeFileSync(
    path.join(OUT_NOTES, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: notesCount, tree: notesTree }, null, 2),
    'utf8',
  );
  console.log(`  ✅ AI 知识库: ${notesCount} 篇`);

  // 2. 同步 reading/ → public/reading/
  rmrf(OUT_READING);
  ensureDir(OUT_READING);
  const readingCount = copyTree(path.join(source, 'reading'), OUT_READING);

  // 读书收藏 manifest：列出所有书目
  const books = [];
  const readingSrc = path.join(source, 'reading');
  for (const entry of fs.readdirSync(readingSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const bookDir = path.join(readingSrc, entry.name);
    const copyrightFile = path.join(bookDir, 'COPYRIGHT.md');
    const notesFile = path.join(bookDir, '我的读书笔记.md');
    const chapters = fs.readdirSync(bookDir)
      .filter((f) => f.endsWith('.md') && f !== 'COPYRIGHT.md' && f !== '我的读书笔记.md' && f !== 'README.md' && f !== '原书README.md')
      .sort();
    books.push({
      slug: entry.name,
      hasCopyright: fs.existsSync(copyrightFile),
      hasNotes: fs.existsSync(notesFile),
      chapters,
      githubUrl: `https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/reading/${encodeURIComponent(entry.name)}`,
    });
  }
  fs.writeFileSync(
    path.join(OUT_READING, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: readingCount, books }, null, 2),
    'utf8',
  );
  console.log(`  ✅ 读书收藏: ${readingCount} 篇`);
}

main();
