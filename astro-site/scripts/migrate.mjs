// 一次性迁移脚本：从 ../index.html 抽出 posts 数组，生成 src/content/blog/*.md
// 用完即删，不要进长期维护。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.resolve(ROOT, '..', 'index.html');
const OUT_DIR = path.resolve(ROOT, 'src', 'content', 'blog');

// ============ 1. 读取并定位 posts 数组 ============

const html = await fs.readFile(HTML_PATH, 'utf8');

const startMarker = 'const posts = [';
const startIdx = html.indexOf(startMarker);
if (startIdx === -1) throw new Error('未在 index.html 里找到 `const posts = [`');

// 括号配平扫描（粗略处理字符串与模板字符串）
let i = startIdx + startMarker.length - 1;
let depth = 0;
let inString = null;
let endIdx = -1;
while (i < html.length) {
  const c = html[i];
  const prev = html[i - 1];
  if (inString) {
    if (c === inString && prev !== '\\') inString = null;
  } else {
    if (c === "'" || c === '"' || c === '`') inString = c;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  i++;
}
if (endIdx === -1) throw new Error('posts 数组括号未配平');

const arraySrc = html.slice(startIdx + 'const posts = '.length, endIdx + 1);
console.log(`[1/3] 定位到 posts 数组：${arraySrc.length} 字符`);

// ============ 2. 沙箱里 eval 出数组 ============

const posts = vm.runInNewContext(`(${arraySrc})`, {}, { timeout: 2000 });
if (!Array.isArray(posts)) throw new Error('eval 结果不是数组');
console.log(`[2/3] 解析到 ${posts.length} 篇文章`);

// ============ 3. 逐篇转 Markdown ============

await fs.mkdir(OUT_DIR, { recursive: true });

const td = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
});
td.use(gfm);

td.addRule('fencedCodeBlock', {
  filter: (node) =>
    node.nodeName === 'PRE' && node.firstChild && node.firstChild.nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = node.firstChild.textContent ?? '';
    const cls = node.firstChild.getAttribute?.('class') ?? '';
    const langMatch = cls.match(/language-([\w-]+)/);
    const lang = langMatch ? langMatch[1] : '';
    return `\n\n\`\`\`${lang}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
  },
});

function yamlEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrontmatter(p) {
  const tags = (p.tags || []).map((t) => `"${yamlEscape(t)}"`).join(', ');
  return [
    '---',
    `title: "${yamlEscape(p.title)}"`,
    `date: ${p.date}`,
    `tags: [${tags}]`,
    `excerpt: "${yamlEscape(p.excerpt)}"`,
    'vip: false',
    'draft: false',
    '---',
    '',
  ].join('\n');
}

function slugify(id) {
  return String(id)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

let ok = 0;
for (const p of posts) {
  if (!p.id || !p.title) {
    console.warn('  跳过：缺少 id 或 title', p);
    continue;
  }
  const slug = slugify(p.id);
  const fm = buildFrontmatter(p);
  const md = td.turndown(p.body || '').trim() + '\n';
  const file = path.join(OUT_DIR, `${slug}.md`);
  await fs.writeFile(file, fm + md, 'utf8');
  ok++;
  console.log(`  ✓ ${slug}.md  (${p.date}, ${(p.tags || []).join('/')})`);
}

console.log(`[3/3] 完成：${ok}/${posts.length} 篇 → ${path.relative(ROOT, OUT_DIR)}/`);
