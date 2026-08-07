/**
 * AI 原理可视化演示 — 可复用模块
 *
 * 对外接口：
 *   AIDemos.mount(type, container, opts)  在容器内挂载一个 demo
 *   AIDemos.has(type)                     是否支持该类型
 *   AIDemos.meta(type)                    取标题/描述/关联笔记
 *   AIDemos.types()                       所有类型
 *
 * 设计约束（重构自 IIFE 版本）：
 * - 所有 DOM 查询限定在容器内（原版用全局 #attnInput 这类 id，同页多实例会冲突）
 * - 每个实例独立状态（原版是模块级单例对象）
 * - opts.compact = true 时省略「说明」折叠区，用于笔记内嵌
 */
(function () {
  'use strict';

  /* ==================== 通用工具 ==================== */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function heatColor(v, min, max) {
    const t = max === min ? 0.5 : (v - min) / (max - min);
    const r = Math.round(255 * Math.min(1, t * 1.6));
    const b = Math.round(255 * Math.min(1, (1 - t) * 1.6));
    const g = Math.round(90 * (1 - Math.abs(t - 0.5) * 2));
    return `rgb(${r},${g},${b})`;
  }

  function softmax(arr) {
    const max = Math.max(...arr);
    const exp = arr.map((v) => Math.exp(v - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    return exp.map((v) => v / sum);
  }

  /** 用字符串哈希生成确定性伪随机向量，保证同一个词每次结果一致 */
  function hashVec(token, dim, salt = 0) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const out = [];
    for (let i = 0; i < dim; i++) {
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      out.push(((h >>> 0) / 4294967295) * 2 - 1);
    }
    return out;
  }

  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const fmtNum = (v) => (v !== 0 && Math.abs(v) < 1e-4 ? v.toExponential(1) : v.toFixed(4));

  /* ==================== Demo 1: 注意力热力图 ==================== */

  function createAttention(root, opts) {
    const state = { tokens: [], dim: 16, causal: true, temp: 1.0 };

    root.innerHTML = `
      <div class="demo-controls">
        <label class="ctl-full">
          <span>输入句子（空格分词，最多 12 个词）</span>
          <input type="text" data-role="input" value="猫 坐在 垫子 上 因为 它 很 舒服" />
        </label>
        <label>
          <span>Temperature <b data-role="tempVal">1.0</b></span>
          <input type="range" data-role="temp" min="0.2" max="3" step="0.1" value="1" />
        </label>
        <label class="ctl-check">
          <input type="checkbox" data-role="causal" checked />
          <span>Causal Mask（只能看左边，GPT 的做法）</span>
        </label>
      </div>
      <div class="demo-output" data-role="out"></div>`;

    const q = (r) => root.querySelector(`[data-role="${r}"]`);
    const input = q('input'), tempEl = q('temp'), causalEl = q('causal');

    function compute() {
      const n = state.tokens.length, d = state.dim;
      const Q = state.tokens.map((t) => hashVec(t, d, 1));
      const K = state.tokens.map((t) => hashVec(t, d, 2));

      const scores = [];
      for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j < n; j++) {
          let s = dot(Q[i], K[j]) / Math.sqrt(d);
          if (state.causal && j > i) s = -Infinity;
          row.push(s);
        }
        scores.push(row);
      }
      return scores.map((row) => {
        const scaled = row.map((s) => (s === -Infinity ? -1e9 : s / state.temp));
        return softmax(scaled).map((p, j) => (row[j] === -Infinity ? null : p));
      });
    }

    function render() {
      const out = q('out');
      const n = state.tokens.length;
      if (n === 0) { out.innerHTML = '<p class="demo-empty">输入一些词试试</p>'; return; }
      const A = compute();

      let html = '<table class="heat-table"><thead><tr><th></th>';
      state.tokens.forEach((t) => (html += `<th>${esc(t)}</th>`));
      html += '</tr></thead><tbody>';
      A.forEach((row, i) => {
        html += `<tr><th>${esc(state.tokens[i])}</th>`;
        row.forEach((p, j) => {
          if (p === null) html += '<td class="masked" title="被 causal mask 屏蔽">—</td>';
          else {
            const pct = (p * 100).toFixed(1);
            html += `<td style="background:${heatColor(p, 0, 1)}" title="${esc(state.tokens[i])} → ${esc(state.tokens[j])}: ${pct}%">${pct}</td>`;
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table>';

      const peaks = A.map((row, i) => {
        let best = -1, bj = 0;
        row.forEach((p, j) => { if (p !== null && p > best) { best = p; bj = j; } });
        return `<code>${esc(state.tokens[i])}</code>→<code>${esc(state.tokens[bj])}</code>`;
      });
      out.innerHTML = html + `<div class="demo-readout"><b>每个 query 最关注的 key：</b>${peaks.join('　')}</div>`;
    }

    function sync() {
      state.tokens = input.value.trim().split(/\s+/).filter(Boolean).slice(0, 12);
      state.causal = causalEl.checked;
      state.temp = parseFloat(tempEl.value);
      q('tempVal').textContent = state.temp.toFixed(1);
      render();
    }

    input.addEventListener('input', sync);
    tempEl.addEventListener('input', sync);
    causalEl.addEventListener('change', sync);
    sync();
  }

  /* ==================== Demo 2: 反向传播 ==================== */

  function createBackprop(root, opts) {
    const st = {
      p: { w1: 0.8, b1: 0.1, w2: -0.6, b2: 0.2 },
      x: 1.5, y: 1.0, lr: 0.1, step: 0, history: [],
    };

    root.innerHTML = `
      <div class="demo-controls">
        <label><span>输入 x = <b data-role="xVal">1.5</b></span>
          <input type="range" data-role="x" min="-2" max="3" step="0.1" value="1.5" /></label>
        <label><span>目标 y = <b data-role="yVal">1.0</b></span>
          <input type="range" data-role="y" min="-2" max="3" step="0.1" value="1" /></label>
        <label><span>学习率 = <b data-role="lrVal">0.10</b></span>
          <input type="range" data-role="lr" min="0.01" max="0.5" step="0.01" value="0.1" /></label>
      </div>
      <div class="demo-btns">
        <button class="btn-primary" data-role="step">训练一步</button>
        <button class="btn-ghost" data-role="run">连续 20 步</button>
        <button class="btn-ghost" data-role="reset">重置</button>
      </div>
      <div class="demo-output" data-role="out"></div>`;

    const q = (r) => root.querySelector(`[data-role="${r}"]`);

    const forward = () => {
      const { w1, b1, w2, b2 } = st.p;
      const z1 = w1 * st.x + b1;
      const h = Math.max(0, z1);
      const yh = w2 * h + b2;
      return { z1, h, yh, loss: (yh - st.y) ** 2 };
    };

    const backward = () => {
      const { z1, h, yh } = forward();
      const dL_dyh = 2 * (yh - st.y);
      const dh_dz1 = z1 > 0 ? 1 : 0;
      const dL_dh = dL_dyh * st.p.w2;
      const dL_dz1 = dL_dh * dh_dz1;
      return {
        dL_dyh, dL_dw2: dL_dyh * h, dL_db2: dL_dyh,
        dL_dh, dh_dz1, dL_dz1, dL_dw1: dL_dz1 * st.x, dL_db1: dL_dz1,
      };
    };

    function sparkline() {
      const h = st.history;
      if (h.length < 2) return '';
      const max = Math.max(...h), min = Math.min(...h);
      const pts = h.map((v, i) => {
        const x = (i / Math.max(1, h.length - 1)) * 100;
        const y = 100 - (max === min ? 50 : ((v - min) / (max - min)) * 90 + 5);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return `<div class="bp-chart"><div class="bp-chart-title">Loss 曲线</div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        </svg></div>`;
    }

    function render() {
      const f = forward(), g = backward();
      q('out').innerHTML = `
        <div class="bp-flow">
          <div class="bp-node"><span class="bp-label">x</span><b>${st.x.toFixed(2)}</b></div>
          <div class="bp-op">×w₁+b₁<br><small>w₁=${fmtNum(st.p.w1)}</small></div>
          <div class="bp-node"><span class="bp-label">z₁</span><b>${fmtNum(f.z1)}</b></div>
          <div class="bp-op">ReLU<br><small>${f.z1 > 0 ? '导数=1' : '导数=0 ⚠️'}</small></div>
          <div class="bp-node"><span class="bp-label">h</span><b>${fmtNum(f.h)}</b></div>
          <div class="bp-op">×w₂+b₂<br><small>w₂=${fmtNum(st.p.w2)}</small></div>
          <div class="bp-node"><span class="bp-label">ŷ</span><b>${fmtNum(f.yh)}</b></div>
          <div class="bp-op">MSE<br><small>目标 ${st.y.toFixed(2)}</small></div>
          <div class="bp-node loss"><span class="bp-label">Loss</span><b>${fmtNum(f.loss)}</b></div>
        </div>
        <div class="bp-back">
          <div class="bp-back-title">↩ 反向传播（链式法则逐层回传）</div>
          <table class="bp-table">
            <tr><td>∂L/∂ŷ = 2(ŷ−y)</td><td><b>${fmtNum(g.dL_dyh)}</b></td></tr>
            <tr><td>∂L/∂w₂ = ∂L/∂ŷ · h</td><td><b>${fmtNum(g.dL_dw2)}</b></td></tr>
            <tr><td>∂L/∂h = ∂L/∂ŷ · w₂</td><td><b>${fmtNum(g.dL_dh)}</b></td></tr>
            <tr class="${g.dh_dz1 === 0 ? 'warn' : ''}"><td>∂h/∂z₁ = ReLU′(z₁)</td><td><b>${g.dh_dz1}</b>${g.dh_dz1 === 0 ? ' ← 梯度在此截断' : ''}</td></tr>
            <tr><td>∂L/∂w₁ = ∂L/∂z₁ · x</td><td><b>${fmtNum(g.dL_dw1)}</b></td></tr>
          </table>
        </div>
        <div class="demo-readout">
          第 <b>${st.step}</b> 步 · Loss = <b>${fmtNum(f.loss)}</b>
          ${st.history.length > 1 ? `· 从 ${fmtNum(st.history[0])} 降到 ${fmtNum(st.history[st.history.length - 1])}` : ''}
          ${g.dh_dz1 === 0 ? '<br><span class="warn-text">⚠️ z₁ ≤ 0，ReLU 导数为 0，w₁ 和 b₁ 收不到任何梯度——这就是「死亡 ReLU」。试着把 x 调大。</span>' : ''}
        </div>${sparkline()}`;
    }

    function doStep() {
      const g = backward();
      st.p.w1 -= st.lr * g.dL_dw1; st.p.b1 -= st.lr * g.dL_db1;
      st.p.w2 -= st.lr * g.dL_dw2; st.p.b2 -= st.lr * g.dL_db2;
      st.step++;
      st.history.push(forward().loss);
      render();
    }

    q('x').addEventListener('input', (e) => { st.x = +e.target.value; q('xVal').textContent = st.x.toFixed(1); render(); });
    q('y').addEventListener('input', (e) => { st.y = +e.target.value; q('yVal').textContent = st.y.toFixed(1); render(); });
    q('lr').addEventListener('input', (e) => { st.lr = +e.target.value; q('lrVal').textContent = st.lr.toFixed(2); });
    q('step').addEventListener('click', doStep);
    q('run').addEventListener('click', () => {
      let i = 0;
      const tick = () => { if (i++ >= 20) return; doStep(); requestAnimationFrame(tick); };
      tick();
    });
    q('reset').addEventListener('click', () => {
      st.p = { w1: 0.8, b1: 0.1, w2: -0.6, b2: 0.2 };
      st.step = 0; st.history = [];
      render();
    });
    render();
  }

  /* ==================== Demo 3: KV Cache ==================== */

  const KV_PRESETS = {
    'llama3-8b':   { label: 'Llama 3 8B',  layers: 32, heads: 32, kvHeads: 8, headDim: 128, weightGB: 16 },
    'llama3-70b':  { label: 'Llama 3 70B', layers: 80, heads: 64, kvHeads: 8, headDim: 128, weightGB: 140 },
    'qwen2.5-7b':  { label: 'Qwen2.5 7B',  layers: 28, heads: 28, kvHeads: 4, headDim: 128, weightGB: 15 },
    'qwen2.5-72b': { label: 'Qwen2.5 72B', layers: 80, heads: 64, kvHeads: 8, headDim: 128, weightGB: 145 },
    'mistral-7b':  { label: 'Mistral 7B',  layers: 32, heads: 32, kvHeads: 8, headDim: 128, weightGB: 15 },
  };

  function createKVCache(root, opts) {
    root.innerHTML = `
      <div class="demo-controls">
        <label><span>模型</span>
          <select data-role="model">
            ${Object.entries(KV_PRESETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select></label>
        <label><span>精度</span>
          <select data-role="dtype">
            <option value="2">fp16 / bf16（2 字节）</option>
            <option value="1">int8（1 字节）</option>
            <option value="4">fp32（4 字节）</option>
          </select></label>
        <label><span>序列长度 = <b data-role="seqVal">8192</b></span>
          <input type="range" data-role="seq" min="512" max="131072" step="512" value="8192" /></label>
        <label><span>Batch = <b data-role="batchVal">1</b></span>
          <input type="range" data-role="batch" min="1" max="64" step="1" value="1" /></label>
      </div>
      <div class="demo-output" data-role="out"></div>`;

    const q = (r) => root.querySelector(`[data-role="${r}"]`);

    function render() {
      const m = KV_PRESETS[q('model').value];
      const seq = +q('seq').value, batch = +q('batch').value, bytes = +q('dtype').value;
      q('seqVal').textContent = seq.toLocaleString();
      q('batchVal').textContent = batch;

      const calc = (kvHeads) => 2 * m.layers * kvHeads * m.headDim * seq * batch * bytes;
      const gqa = calc(m.kvHeads), mha = calc(m.heads), mqa = calc(1);
      const gb = (b) => b / 1024 ** 3;
      const fmtGB = (b) => (gb(b) < 0.1 ? (b / 1024 ** 2).toFixed(1) + ' MB' : gb(b).toFixed(2) + ' GB');
      const maxBar = Math.max(mha, gqa, mqa);
      const bar = (v) => `<i style="width:${(v / maxBar * 100).toFixed(1)}%"></i>`;
      const perReq = gb(gqa) / batch;
      const fits = perReq > 0 ? Math.max(0, Math.floor((80 - m.weightGB) / perReq)) : 0;

      q('out').innerHTML = `
        <div class="kv-formula">
          KV Cache = 2 × layers × kv_heads × head_dim × seq_len × batch × bytes<br>
          <span class="kv-formula-nums">= 2 × ${m.layers} × ${m.kvHeads} × ${m.headDim} × ${seq.toLocaleString()} × ${batch} × ${bytes}</span>
        </div>
        <div class="kv-headline">
          <span>该模型实际配置（GQA, kv_heads=${m.kvHeads}）</span><b>${fmtGB(gqa)}</b>
        </div>
        <table class="kv-table">
          <tr><th>方案</th><th>kv_heads</th><th>显存</th><th></th></tr>
          <tr><td>MHA（每头独立 KV）</td><td>${m.heads}</td><td>${fmtGB(mha)}</td><td class="kv-bar">${bar(mha)}</td></tr>
          <tr class="hl"><td>GQA（分组共享）</td><td>${m.kvHeads}</td><td>${fmtGB(gqa)}</td><td class="kv-bar">${bar(gqa)}</td></tr>
          <tr><td>MQA（全部共享）</td><td>1</td><td>${fmtGB(mqa)}</td><td class="kv-bar">${bar(mqa)}</td></tr>
        </table>
        <div class="demo-readout">
          GQA 相比 MHA 省了 <b>${(mha / gqa).toFixed(1)}×</b> 显存。序列长度翻倍，KV Cache 就翻倍——<b>线性增长</b>。
          <br>单张 A100 80GB 除去 ${m.label} 权重（约 ${m.weightGB} GB @fp16）后，约能放 <b>${fits}</b> 条这样的并发请求。
        </div>`;
    }

    ['model', 'dtype', 'seq', 'batch'].forEach((r) => {
      q(r).addEventListener('input', render);
      q(r).addEventListener('change', render);
    });
    render();
  }

  /* ==================== Demo 4: TIES 模型合并 ==================== */

  function createTies(root, opts) {
    const st = {
      dim: 8,
      a: [0.8, 0.6, 0.5, 0.4, -0.3, 0.02, -0.01, 0.0],
      b: [-0.7, -0.5, 0.4, 0.5, 0.4, -0.01, 0.02, 0.01],
      trimK: 0.6,
    };

    root.innerHTML = `
      <div class="demo-controls">
        <label><span>Trim 保留比例 = <b data-role="trimVal">60%</b></span>
          <input type="range" data-role="trim" min="0.2" max="1" step="0.1" value="0.6" /></label>
      </div>
      <div class="demo-btns"><button class="btn-ghost" data-role="random">随机生成任务向量</button></div>
      <div class="demo-output" data-role="out"></div>`;

    const q = (r) => root.querySelector(`[data-role="${r}"]`);

    function ties() {
      const trim = (t) => {
        const n = Math.max(1, Math.round(t.length * st.trimK));
        const keep = new Set(t.map((v, i) => [Math.abs(v), i]).sort((p, r) => r[0] - p[0]).slice(0, n).map((p) => p[1]));
        return t.map((v, i) => (keep.has(i) ? v : 0));
      };
      const ta = trim(st.a), tb = trim(st.b);
      const merged = [], signs = [];
      for (let j = 0; j < st.dim; j++) {
        const col = [ta[j], tb[j]];
        const pos = col.filter((v) => v > 0).reduce((s, v) => s + v, 0);
        const neg = col.filter((v) => v < 0).reduce((s, v) => s - v, 0);
        const sign = pos === 0 && neg === 0 ? 0 : (pos >= neg ? 1 : -1);
        signs.push(sign);
        const agree = col.filter((v) => v !== 0 && Math.sign(v) === sign);
        merged.push(agree.length ? agree.reduce((s, v) => s + v, 0) / agree.length : 0);
      }
      return { ta, tb, merged, signs };
    }

    function render() {
      const { ta, tb, merged, signs } = ties();
      const naive = st.a.map((v, i) => (v + st.b[i]) / 2);

      const cell = (v) => {
        if (v === 0) return '<td class="zero">0</td>';
        const mag = Math.min(1, Math.abs(v));
        const col = v > 0 ? `rgba(220,60,60,${0.15 + mag * 0.55})` : `rgba(60,110,220,${0.15 + mag * 0.55})`;
        return `<td style="background:${col}">${v.toFixed(2)}</td>`;
      };
      const row = (label, arr, cls = '', note = '') =>
        `<tr class="${cls}"><th>${label}${note ? `<small>${note}</small>` : ''}</th>${arr.map(cell).join('')}</tr>`;

      const conflicts = [];
      for (let j = 0; j < st.dim; j++) {
        if (st.a[j] * st.b[j] < 0 && Math.abs(st.a[j]) > 0.05) conflicts.push(j);
      }
      const mag = (arr, idx) => (idx.length ? (idx.reduce((s, j) => s + Math.abs(arr[j]), 0) / idx.length).toFixed(3) : '—');

      q('out').innerHTML = `
        <table class="ties-table">
          <thead><tr><th>参数位置</th>${st.a.map((_, i) => `<th>${i}</th>`).join('')}</tr></thead>
          <tbody>
            ${row('任务向量 A', st.a, '', '<br>模型A微调产生的变化')}
            ${row('任务向量 B', st.b, '', '<br>模型B微调产生的变化')}
            <tr class="sep"><th colspan="${st.dim + 1}">↓ Step 1: Trim — 各自只保留幅值最大的 ${(st.trimK * 100).toFixed(0)}%</th></tr>
            ${row('A (trimmed)', ta)}
            ${row('B (trimmed)', tb)}
            <tr class="sep"><th colspan="${st.dim + 1}">↓ Step 2: Elect Sign — 按正负总幅值投票</th></tr>
            <tr class="signs"><th>选举结果</th>${signs.map((s) => `<td>${s > 0 ? '＋' : s < 0 ? '－' : '·'}</td>`).join('')}</tr>
            <tr class="sep"><th colspan="${st.dim + 1}">↓ Step 3: Disjoint Merge — 只平均符号一致的值</th></tr>
            ${row('TIES 结果', merged, 'result')}
            <tr class="sep compare"><th colspan="${st.dim + 1}">对比：朴素平均（不做符号选举）</th></tr>
            ${row('朴素平均', naive, 'naive')}
          </tbody>
        </table>
        <div class="demo-readout">
          ${conflicts.length ? `
            <b>符号冲突位置：</b>${conflicts.join(', ')}<br>
            TIES 保留的平均幅值 <b>${mag(merged, conflicts)}</b>，朴素平均只剩 <b>${mag(naive, conflicts)}</b>
            — 朴素平均把两个模型的意图<b>互相抵消</b>了。`
            : '当前没有符号冲突位置，点「随机生成」试试。'}
        </div>`;
    }

    q('trim').addEventListener('input', (e) => {
      st.trimK = +e.target.value;
      q('trimVal').textContent = (st.trimK * 100).toFixed(0) + '%';
      render();
    });
    q('random').addEventListener('click', () => {
      const rnd = () => Array.from({ length: st.dim }, (_, i) =>
        i < 5 ? +(Math.random() * 1.6 - 0.8).toFixed(2) : +(Math.random() * 0.06 - 0.03).toFixed(3));
      st.a = rnd(); st.b = rnd();
      render();
    });
    render();
  }

  /* ==================== 注册表 ==================== */

  const REGISTRY = {
    attention: {
      title: '注意力机制热力图',
      note: '02-llm/01-Transformer原理/01-注意力机制推导.md',
      noteLabel: '注意力机制推导',
      create: createAttention,
    },
    backprop: {
      title: '反向传播梯度流',
      note: '01-machine-learning/04-神经网络原理/02-反向传播推导.md',
      noteLabel: '反向传播推导',
      create: createBackprop,
    },
    kvcache: {
      title: 'KV Cache 显存计算器',
      note: '02-llm/05-推理优化/01-KV-Cache与显存分析.md',
      noteLabel: 'KV Cache 与显存分析',
      create: createKVCache,
    },
    ties: {
      title: 'TIES 模型合并',
      note: '02-llm/04-微调与对齐/05-模型合并.md',
      noteLabel: '模型合并',
      create: createTies,
    },
  };

  window.AIDemos = {
    has: (type) => Object.prototype.hasOwnProperty.call(REGISTRY, type),
    types: () => Object.keys(REGISTRY),
    meta: (type) => {
      const d = REGISTRY[type];
      return d ? { title: d.title, note: d.note, noteLabel: d.noteLabel } : null;
    },
    /**
     * @param {string} type
     * @param {HTMLElement} container
     * @param {object} opts { compact }
     */
    mount(type, container, opts = {}) {
      const d = REGISTRY[type];
      if (!d || !container) return false;
      container.classList.add('demo-instance');
      d.create(container, opts);
      return true;
    },
  };
})();
