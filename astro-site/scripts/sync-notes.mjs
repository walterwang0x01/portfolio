#!/usr/bin/env node
/**
 * 构建期同步 AI 知识库 + 读书收藏 → public/notes/ 和 public/reading/
 *
 * 产出三类数据：
 *   1. 原始 md 文件（供阅读视图 fetch）
 *   2. manifest.json — 目录树 + 路线图元数据（供导航）
 *   3. quiz.json     — 从「读完你能回答的 3 个问题」提取的自测题库
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

// 学习路线定义：顺序 + 定位 + 预计时长（分钟/篇按 12KB≈20min 估）
const ROADMAP = [
  {
    id: '00-入门准备',
    label: '入门准备',
    emoji: '🚀',
    tagline: 'AI 全景认知、环境搭建、学习路线',
    why: '先建立全局地图，避免一头扎进细节',
  },
  {
    id: '01-machine-learning',
    label: '机器学习原理',
    emoji: '📐',
    tagline: '数学基础 → 经典算法 → 神经网络 → 训练工程',
    why: '一切的地基。不懂反向传播就无法判断「模型为什么这样输出」',
  },
  {
    id: '02-llm',
    label: '大语言模型',
    emoji: '🧠',
    tagline: 'Transformer → 分词 → 预训练 → 微调对齐 → 推理优化',
    why: '从「会用 API」到「知道内部发生了什么」的分水岭',
  },
  {
    id: '03-实战项目',
    label: '实战项目',
    emoji: '🔧',
    tagline: 'PyTorch 训练实战、端到端项目',
    why: '理论学完必须动手验证，否则都是纸上的字',
  },
  {
    id: '04-ai-agent',
    label: 'AI Agent 工程',
    emoji: '🤖',
    tagline: '框架 / 协议 / RAG / 工具 / 记忆 / 安全 / Harness',
    why: '应用层的全部工程实践，需要前面所有基础',
  },
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

/** 去掉数字前缀，用于展示 */
function prettify(name) {
  return name.replace(/\.md$/, '').replace(/^\d+[-.]?\s*/, '');
}

/**
 * 从 md 内容提取「读完你能回答的 3 个问题」
 * 格式约定：
 *   > **读完你能回答的 3 个问题**
 *   >
 *   > 1. 问题一
 *   > 2. 问题二
 *   > 3. 问题三
 */
function extractQuestions(content) {
  const anchor = content.indexOf('读完你能回答的');
  if (anchor === -1) return [];

  // 从锚点往后取 1500 字符足够覆盖三个问题
  const chunk = content.slice(anchor, anchor + 1500);
  const questions = [];
  // 匹配 blockquote 里的有序列表项：> 1. xxx
  const re = /^>\s*(\d)\.\s*(.+?)$/gm;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const text = m[2].trim();
    if (text) questions.push(text);
    if (questions.length >= 3) break;
  }
  return questions;
}

/** 提取一级标题作为笔记标题 */
function extractTitle(content, fallback) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function copyTree(srcDir, destDir, relBase = '') {
  if (!fs.existsSync(srcDir)) return { count: 0, files: [] };
  let count = 0;
  const collected = [];

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = path.posix.join(relBase, entry.name);
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      if (isExcluded(rel) || entry.name.startsWith('.')) continue;
      const sub = copyTree(src, dest, rel);
      count += sub.count;
      collected.push(...sub.files);
    } else if (entry.name.endsWith('.md')) {
      const content = fs.readFileSync(src, 'utf8');
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, content, 'utf8');
      count += 1;
      collected.push({ rel, content, size: Buffer.byteLength(content, 'utf8') });
    }
  }
  return { count, files: collected };
}

/** 构建目录树（供阅读视图的侧栏） */
function buildTree(dir, relBase = '') {
  const node = { name: relBase, children: [], files: [] };
  if (!fs.existsSync(dir)) return node;

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  for (const entry of entries) {
    const rel = path.posix.join(relBase, entry.name);
    if (entry.isDirectory()) {
      node.children.push(buildTree(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith('.md') && entry.name !== 'manifest.json') {
      node.files.push(rel);
    }
  }
  return node;
}

function main() {
  console.log('📚 同步 AI 知识库 + 读书收藏 …');

  const source = findSource();
  if (!source) {
    console.warn('  ⚠️  未找到 tech-learning-and-projects 源，写空 manifest');
    ensureDir(OUT_NOTES);
    fs.writeFileSync(
      path.join(OUT_NOTES, 'manifest.json'),
      JSON.stringify({ count: 0, tree: { children: [], files: [] }, roadmap: [] }),
      'utf8',
    );
    fs.writeFileSync(path.join(OUT_NOTES, 'quiz.json'), JSON.stringify({ total: 0, items: [] }), 'utf8');
    ensureDir(OUT_READING);
    fs.writeFileSync(path.join(OUT_READING, 'manifest.json'), JSON.stringify({ books: [] }), 'utf8');
    return;
  }

  console.log(`  📂 源: ${source}`);

  // ---------- 1. 同步 00-ai/ → public/notes/ ----------
  rmrf(OUT_NOTES);
  ensureDir(OUT_NOTES);
  const { count: notesCount, files } = copyTree(path.join(source, 'learning-notes/00-ai'), OUT_NOTES);

  // ---------- 2. 提取自测题库 ----------
  const quizItems = [];
  for (const f of files) {
    const questions = extractQuestions(f.content);
    if (questions.length === 0) continue;

    const parts = f.rel.split('/');
    const moduleId = parts[0];                       // 如 02-llm
    const section = parts.length > 2 ? parts[1] : '';  // 如 04-微调与对齐

    quizItems.push({
      file: f.rel,
      title: extractTitle(f.content, prettify(parts[parts.length - 1])),
      module: moduleId,
      moduleLabel: ROADMAP.find((r) => r.id === moduleId)?.label ?? prettify(moduleId),
      section: section ? prettify(section) : '',
      questions,
    });
  }
  const totalQuestions = quizItems.reduce((n, it) => n + it.questions.length, 0);
  fs.writeFileSync(
    path.join(OUT_NOTES, 'quiz.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), notes: quizItems.length, total: totalQuestions, items: quizItems }, null, 2),
    'utf8',
  );

  // ---------- 3. 构建 manifest（目录树 + 路线图统计） ----------
  const tree = buildTree(OUT_NOTES);

  const roadmap = ROADMAP.map((stage) => {
    const stageFiles = files.filter((f) => f.rel.startsWith(stage.id + '/'));
    const totalBytes = stageFiles.reduce((n, f) => n + f.size, 0);
    const quizCount = quizItems
      .filter((it) => it.module === stage.id)
      .reduce((n, it) => n + it.questions.length, 0);
    // 阅读时长估算：中文约 500 字/分钟，1 汉字≈3 字节
    const minutes = Math.round(totalBytes / 3 / 500);
    return {
      ...stage,
      notes: stageFiles.length,
      quizCount,
      minutes,
      files: stageFiles.map((f) => f.rel).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    };
  });

  fs.writeFileSync(
    path.join(OUT_NOTES, 'manifest.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: notesCount, quizTotal: totalQuestions, roadmap, tree },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`  ✅ AI 知识库: ${notesCount} 篇`);
  console.log(`  ✅ 自测题库: ${quizItems.length} 篇笔记 / ${totalQuestions} 道题`);
  for (const s of roadmap) {
    console.log(`     ${s.emoji} ${s.label}: ${s.notes} 篇 · ${s.quizCount} 题 · 约 ${s.minutes} 分钟`);
  }

  // ---------- 4. 同步 reading/ → public/reading/ ----------
  rmrf(OUT_READING);
  ensureDir(OUT_READING);
  const readingSrc = path.join(source, 'reading');
  const { count: readingCount } = copyTree(readingSrc, OUT_READING);

  const books = [];
  if (fs.existsSync(readingSrc)) {
    for (const entry of fs.readdirSync(readingSrc, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const bookDir = path.join(readingSrc, entry.name);
      const chapters = fs
        .readdirSync(bookDir)
        .filter((f) => f.endsWith('.md') && !['COPYRIGHT.md', '我的读书笔记.md', 'README.md', '原书README.md'].includes(f))
        .sort();
      books.push({
        slug: entry.name,
        hasCopyright: fs.existsSync(path.join(bookDir, 'COPYRIGHT.md')),
        hasNotes: fs.existsSync(path.join(bookDir, '我的读书笔记.md')),
        chapters,
        githubUrl: `https://github.com/walterwang0x01/tech-learning-and-projects/tree/main/reading/${encodeURIComponent(entry.name)}`,
      });
    }
  }
  fs.writeFileSync(
    path.join(OUT_READING, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: readingCount, books }, null, 2),
    'utf8',
  );
  console.log(`  ✅ 读书收藏: ${readingCount} 篇`);
}

main();
