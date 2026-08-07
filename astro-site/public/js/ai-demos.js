/**
 * AI 原理可视化演示
 * 四个 demo：注意力热力图 / 反向传播 / KV Cache 显存 / TIES 模型合并
 * 纯原生 JS + Canvas，无外部依赖
 */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ==================== 通用工具 ==================== */

  /** 数值 → 蓝红色阶（用于热力图） */
  function heatColor(v, min, max) {
    const t = max === min ? 0.5 : (v - min) / (max - min);
    // 低值偏蓝，高值偏红
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
      out.push(((h >>> 0) / 4294967295) * 2 - 1);   // [-1, 1]
    }
    return out;
  }

  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

  /* ==================== Demo 1: 注意力热力图 ==================== */

  const Attention = {
    tokens: [],
    dim: 16,
    causal: true,
    temp: 1.0,

    init() {
      const input = $('#attnInput');
      const causalBox = $('#attnCausal');
      const tempSlider = $('#attnTemp');
      if (!input) return;

      const rerender = () => {
        this.tokens = input.value.trim().split(/\s+/).filter(Boolean).slice(0, 12);
        this.causal = causalBox.checked;
        this.temp = parseFloat(tempSlider.value);
        $('#attnTempVal').textContent = this.temp.toFixed(1);
        this.render();
      };

      input.addEventListener('input', rerender);
      causalBox.addEventListener('change', rerender);
      tempSlider.addEventListener('input', rerender);
      rerender();
    },

    /** 计算注意力矩阵：Q·K^T / sqrt(d) → mask → softmax */
    compute() {
      const n = this.tokens.length;
      const d = this.dim;
      // 用哈希生成确定性的 Q/K 向量（salt 不同代表不同投影矩阵）
      const Q = this.tokens.map((t) => hashVec(t, d, 1));
      const K = this.tokens.map((t) => hashVec(t, d, 2));

      const scores = [];
      for (let i = 0; i < n; i++) {
        const row = [];
        for (let j = 0; j < n; j++) {
          let s = dot(Q[i], K[j]) / Math.sqrt(d);
          if (this.causal && j > i) s = -Infinity;   // causal mask
          row.push(s);
        }
        scores.push(row);
      }
      // 按温度缩放后 softmax
      return scores.map((row) => {
        const scaled = row.map((s) => (s === -Infinity ? -Infinity : s / this.temp));
        const valid = scaled.map((s) => (s === -Infinity ? -1e9 : s));
        return softmax(valid).map((p, j) => (row[j] === -Infinity ? null : p));
      });
    },

    render() {
      const host = $('#attnMatrix');
      const n = this.tokens.length;
      if (n === 0) {
        host.innerHTML = '<p class="demo-empty">输入一些词试试</p>';
        return;
      }
      const A = this.compute();

      let html = '<table class="heat-table"><thead><tr><th></th>';
      this.tokens.forEach((t) => (html += `<th title="key: ${t}">${t}</th>`));
      html += '</tr></thead><tbody>';

      A.forEach((row, i) => {
        html += `<tr><th title="query: ${this.tokens[i]}">${this.tokens[i]}</th>`;
        row.forEach((p, j) => {
          if (p === null) {
            html += '<td class="masked" title="被 causal mask 屏蔽">—</td>';
          } else {
            const pct = (p * 100).toFixed(1);
            html += `<td style="background:${heatColor(p, 0, 1)}" title="${this.tokens[i]} → ${this.tokens[j]}: ${pct}%">${pct}</td>`;
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table>';

      // 观察提示：找出每行最大注意力的目标
      const peaks = A.map((row, i) => {
        let best = -1, bj = 0;
        row.forEach((p, j) => { if (p !== null && p > best) { best = p; bj = j; } });
        return `<code>${this.tokens[i]}</code> → <code>${this.tokens[bj]}</code> (${(best * 100).toFixed(0)}%)`;
      });

      host.innerHTML = html + `
        <div class="demo-readout">
          <b>每个 query 最关注的 key：</b>${peaks.join('　')}
        </div>`;
    },
  };

  /* ==================== Demo 2: 反向传播 ==================== */

  const Backprop = {
    // 网络：x -> [w1,b1] -> h(ReLU) -> [w2,b2] -> y_hat -> MSE(y)
    p: { w1: 0.8, b1: 0.1, w2: -0.6, b2: 0.2 },
    x: 1.5,
    y: 1.0,
    lr: 0.1,
    step: 0,
    history: [],

    init() {
      if (!$('#bpGraph')) return;
      $('#bpX').addEventListener('input', (e) => { this.x = +e.target.value; $('#bpXVal').textContent = this.x.toFixed(1); this.render(); });
      $('#bpY').addEventListener('input', (e) => { this.y = +e.target.value; $('#bpYVal').textContent = this.y.toFixed(1); this.render(); });
      $('#bpLr').addEventListener('input', (e) => { this.lr = +e.target.value; $('#bpLrVal').textContent = this.lr.toFixed(2); });
      $('#bpStep').addEventListener('click', () => this.doStep());
      $('#bpRun').addEventListener('click', () => this.run(20));
      $('#bpReset').addEventListener('click', () => this.reset());
      this.render();
    },

    forward() {
      const { w1, b1, w2, b2 } = this.p;
      const z1 = w1 * this.x + b1;
      const h = Math.max(0, z1);                  // ReLU
      const yh = w2 * h + b2;
      const loss = (yh - this.y) ** 2;
      return { z1, h, yh, loss };
    },

    backward() {
      const { w2 } = this.p;
      const { z1, h, yh } = this.forward();
      const dL_dyh = 2 * (yh - this.y);           // MSE 导数
      const dL_dw2 = dL_dyh * h;
      const dL_db2 = dL_dyh;
      const dL_dh = dL_dyh * w2;
      const dh_dz1 = z1 > 0 ? 1 : 0;              // ReLU 导数（这是梯度消失的来源）
      const dL_dz1 = dL_dh * dh_dz1;
      const dL_dw1 = dL_dz1 * this.x;
      const dL_db1 = dL_dz1;
      return { dL_dyh, dL_dw2, dL_db2, dL_dh, dh_dz1, dL_dz1, dL_dw1, dL_db1 };
    },

    doStep() {
      const g = this.backward();
      this.p.w1 -= this.lr * g.dL_dw1;
      this.p.b1 -= this.lr * g.dL_db1;
      this.p.w2 -= this.lr * g.dL_dw2;
      this.p.b2 -= this.lr * g.dL_db2;
      this.step++;
      this.history.push(this.forward().loss);
      this.render();
    },

    run(n) {
      let i = 0;
      const tick = () => {
        if (i++ >= n) return;
        this.doStep();
        requestAnimationFrame(tick);
      };
      tick();
    },

    reset() {
      this.p = { w1: 0.8, b1: 0.1, w2: -0.6, b2: 0.2 };
      this.step = 0;
      this.history = [];
      this.render();
    },

    render() {
      const f = this.forward();
      const g = this.backward();
      const fmt = (v) => (Math.abs(v) < 1e-4 && v !== 0 ? v.toExponential(1) : v.toFixed(4));

      $('#bpGraph').innerHTML = `
        <div class="bp-flow">
          <div class="bp-node"><span class="bp-label">x</span><b>${this.x.toFixed(2)}</b></div>
          <div class="bp-op">×w₁+b₁<br><small>w₁=${fmt(this.p.w1)}</small></div>
          <div class="bp-node"><span class="bp-label">z₁</span><b>${fmt(f.z1)}</b></div>
          <div class="bp-op">ReLU<br><small>${f.z1 > 0 ? '导数=1' : '导数=0 ⚠️'}</small></div>
          <div class="bp-node"><span class="bp-label">h</span><b>${fmt(f.h)}</b></div>
          <div class="bp-op">×w₂+b₂<br><small>w₂=${fmt(this.p.w2)}</small></div>
          <div class="bp-node"><span class="bp-label">ŷ</span><b>${fmt(f.yh)}</b></div>
          <div class="bp-op">MSE<br><small>目标 ${this.y.toFixed(2)}</small></div>
          <div class="bp-node loss"><span class="bp-label">Loss</span><b>${fmt(f.loss)}</b></div>
        </div>

        <div class="bp-back">
          <div class="bp-back-title">↩ 反向传播（链式法则逐层回传）</div>
          <table class="bp-table">
            <tr><td>∂L/∂ŷ = 2(ŷ−y)</td><td><b>${fmt(g.dL_dyh)}</b></td></tr>
            <tr><td>∂L/∂w₂ = ∂L/∂ŷ · h</td><td><b>${fmt(g.dL_dw2)}</b></td></tr>
            <tr><td>∂L/∂h = ∂L/∂ŷ · w₂</td><td><b>${fmt(g.dL_dh)}</b></td></tr>
            <tr class="${g.dh_dz1 === 0 ? 'warn' : ''}"><td>∂h/∂z₁ = ReLU′(z₁)</td><td><b>${g.dh_dz1}</b>${g.dh_dz1 === 0 ? ' ← 梯度在此截断' : ''}</td></tr>
            <tr><td>∂L/∂w₁ = ∂L/∂z₁ · x</td><td><b>${fmt(g.dL_dw1)}</b></td></tr>
          </table>
        </div>

        <div class="demo-readout">
          第 <b>${this.step}</b> 步 · Loss = <b>${fmt(f.loss)}</b>
          ${this.history.length > 1 ? `· 从 ${fmt(this.history[0])} 降到 ${fmt(this.history[this.history.length - 1])}` : ''}
          ${g.dh_dz1 === 0 ? '<br><span class="warn-text">⚠️ z₁ ≤ 0，ReLU 导数为 0，w₁ 和 b₁ 收不到任何梯度——这就是「死亡 ReLU」。试着把 x 调大。</span>' : ''}
        </div>
        ${this.history.length > 1 ? this.sparkline() : ''}`;
    },

    sparkline() {
      const h = this.history;
      const max = Math.max(...h), min = Math.min(...h);
      const pts = h.map((v, i) => {
        const x = (i / Math.max(1, h.length - 1)) * 100;
        const y = 100 - (max === min ? 50 : ((v - min) / (max - min)) * 90 + 5);
        return `${x},${y}`;
      }).join(' ');
      return `<div class="bp-chart">
        <div class="bp-chart-title">Loss 曲线</div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        </svg>
      </div>`;
    },
  };

  /* ==================== Demo 3: KV Cache 显存计算器 ==================== */

  const KVCache = {
    presets: {
      'llama3-8b':   { label: 'Llama 3 8B',    layers: 32, heads: 32, kvHeads: 8,  headDim: 128 },
      'llama3-70b':  { label: 'Llama 3 70B',   layers: 80, heads: 64, kvHeads: 8,  headDim: 128 },
      'qwen2.5-7b':  { label: 'Qwen2.5 7B',    layers: 28, heads: 28, kvHeads: 4,  headDim: 128 },
      'qwen2.5-72b': { label: 'Qwen2.5 72B',   layers: 80, heads: 64, kvHeads: 8,  headDim: 128 },
      'mistral-7b':  { label: 'Mistral 7B',    layers: 32, heads: 32, kvHeads: 8,  headDim: 128 },
    },

    init() {
      if (!$('#kvModel')) return;
      const sel = $('#kvModel');
      sel.innerHTML = Object.entries(this.presets)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
      ['kvModel', 'kvSeq', 'kvBatch', 'kvDtype'].forEach((id) => {
        $('#' + id).addEventListener('input', () => this.render());
        $('#' + id).addEventListener('change', () => this.render());
      });
      this.render();
    },

    render() {
      const m = this.presets[$('#kvModel').value];
      const seq = +$('#kvSeq').value;
      const batch = +$('#kvBatch').value;
      const bytes = +$('#kvDtype').value;

      $('#kvSeqVal').textContent = seq.toLocaleString();
      $('#kvBatchVal').textContent = batch;

      // KV Cache = 2(K和V) × layers × kv_heads × head_dim × seq × batch × bytes
      const calc = (kvHeads) => 2 * m.layers * kvHeads * m.headDim * seq * batch * bytes;
      const gqa = calc(m.kvHeads);
      const mha = calc(m.heads);        // 假设不用 GQA（每个 head 独立 KV）
      const mqa = calc(1);              // 极端：所有 head 共享一组 KV

      const gb = (b) => b / 1024 ** 3;
      const fmtGB = (b) => (gb(b) < 0.1 ? (b / 1024 ** 2).toFixed(1) + ' MB' : gb(b).toFixed(2) + ' GB');

      const maxBar = Math.max(mha, gqa, mqa);
      const bar = (v) => `<i style="width:${(v / maxBar * 100).toFixed(1)}%"></i>`;

      $('#kvResult').innerHTML = `
        <div class="kv-formula">
          KV Cache = 2 × layers × kv_heads × head_dim × seq_len × batch × bytes<br>
          <span class="kv-formula-nums">= 2 × ${m.layers} × ${m.kvHeads} × ${m.headDim} × ${seq.toLocaleString()} × ${batch} × ${bytes}</span>
        </div>

        <div class="kv-headline">
          <span>该模型实际配置（GQA, kv_heads=${m.kvHeads}）</span>
          <b>${fmtGB(gqa)}</b>
        </div>

        <table class="kv-table">
          <tr><th>方案</th><th>kv_heads</th><th>显存</th><th></th></tr>
          <tr><td>MHA（每头独立 KV）</td><td>${m.heads}</td><td>${fmtGB(mha)}</td><td class="kv-bar">${bar(mha)}</td></tr>
          <tr class="hl"><td>GQA（分组共享）</td><td>${m.kvHeads}</td><td>${fmtGB(gqa)}</td><td class="kv-bar">${bar(gqa)}</td></tr>
          <tr><td>MQA（全部共享）</td><td>1</td><td>${fmtGB(mqa)}</td><td class="kv-bar">${bar(mqa)}</td></tr>
        </table>

        <div class="demo-readout">
          GQA 相比 MHA 省了 <b>${(mha / gqa).toFixed(1)}×</b> 显存。
          序列长度翻倍，KV Cache 就翻倍——<b>线性增长</b>，这是长上下文的主要成本来源。
          <br>参考：单张 A100 80GB 除去 ${m.label} 权重（约 ${(m.layers * 0.5).toFixed(0)} GB @fp16）后，
          还能放约 <b>${Math.max(0, Math.floor((80 - m.layers * 0.5) / gb(gqa) * batch))}</b> 条这样的并发请求。
        </div>`;
    },
  };

  /* ==================== Demo 4: TIES 模型合并 ==================== */

  const Ties = {
    dim: 8,
    a: [0.8, 0.6, 0.5, 0.4, -0.3, 0.02, -0.01, 0.0],
    b: [-0.7, -0.5, 0.4, 0.5, 0.4, -0.01, 0.02, 0.01],
    trimK: 0.6,

    init() {
      if (!$('#tiesBody')) return;
      $('#tiesTrim').addEventListener('input', (e) => {
        this.trimK = +e.target.value;
        $('#tiesTrimVal').textContent = (this.trimK * 100).toFixed(0) + '%';
        this.render();
      });
      $('#tiesRandom').addEventListener('click', () => {
        const rnd = () => Array.from({ length: this.dim }, (_, i) =>
          i < 5 ? +(Math.random() * 1.6 - 0.8).toFixed(2) : +(Math.random() * 0.06 - 0.03).toFixed(3));
        this.a = rnd(); this.b = rnd();
        this.render();
      });
      this.render();
    },

    ties() {
      const trim = (t) => {
        const n = Math.max(1, Math.round(t.length * this.trimK));
        const idx = t.map((v, i) => [Math.abs(v), i]).sort((p, q) => q[0] - p[0]).slice(0, n).map((p) => p[1]);
        return t.map((v, i) => (idx.includes(i) ? v : 0));
      };
      const ta = trim(this.a), tb = trim(this.b);

      const merged = [], signs = [];
      for (let j = 0; j < this.dim; j++) {
        const col = [ta[j], tb[j]];
        const pos = col.filter((v) => v > 0).reduce((s, v) => s + v, 0);
        const neg = col.filter((v) => v < 0).reduce((s, v) => s - v, 0);
        const sign = pos >= neg ? 1 : -1;
        signs.push(pos === 0 && neg === 0 ? 0 : sign);
        const agree = col.filter((v) => v !== 0 && Math.sign(v) === sign);
        merged.push(agree.length ? agree.reduce((s, v) => s + v, 0) / agree.length : 0);
      }
      return { ta, tb, merged, signs };
    },

    render() {
      const { ta, tb, merged, signs } = this.ties();
      const naive = this.a.map((v, i) => (v + this.b[i]) / 2);

      const cell = (v, extra = '') => {
        if (v === 0) return `<td class="zero ${extra}">0</td>`;
        const mag = Math.min(1, Math.abs(v) / 1.0);
        const col = v > 0 ? `rgba(220,60,60,${0.15 + mag * 0.55})` : `rgba(60,110,220,${0.15 + mag * 0.55})`;
        return `<td style="background:${col}" class="${extra}">${v.toFixed(2)}</td>`;
      };

      const row = (label, arr, cls = '', note = '') => `
        <tr class="${cls}">
          <th>${label}${note ? `<small>${note}</small>` : ''}</th>
          ${arr.map((v) => cell(v)).join('')}
        </tr>`;

      const conflictIdx = [];
      for (let j = 0; j < this.dim; j++) {
        if (this.a[j] * this.b[j] < 0 && Math.abs(this.a[j]) > 0.05) conflictIdx.push(j);
      }

      const magOf = (arr, idxs) => idxs.length
        ? (idxs.reduce((s, j) => s + Math.abs(arr[j]), 0) / idxs.length).toFixed(3) : '—';

      $('#tiesBody').innerHTML = `
        <table class="ties-table">
          <thead><tr><th>参数位置</th>${this.a.map((_, i) => `<th>${i}</th>`).join('')}</tr></thead>
          <tbody>
            ${row('任务向量 A', this.a, '', '<br>模型A微调产生的变化')}
            ${row('任务向量 B', this.b, '', '<br>模型B微调产生的变化')}
            <tr class="sep"><th colspan="${this.dim + 1}">↓ Step 1: Trim — 各自只保留幅值最大的 ${(this.trimK * 100).toFixed(0)}%</th></tr>
            ${row('A (trimmed)', ta)}
            ${row('B (trimmed)', tb)}
            <tr class="sep"><th colspan="${this.dim + 1}">↓ Step 2: Elect Sign — 按正负总幅值投票</th></tr>
            <tr class="signs"><th>选举结果</th>${signs.map((s) => `<td>${s > 0 ? '＋' : s < 0 ? '－' : '·'}</td>`).join('')}</tr>
            <tr class="sep"><th colspan="${this.dim + 1}">↓ Step 3: Disjoint Merge — 只平均符号一致的值</th></tr>
            ${row('TIES 结果', merged, 'result')}
            <tr class="sep compare"><th colspan="${this.dim + 1}">对比：朴素平均（不做符号选举）</th></tr>
            ${row('朴素平均', naive, 'naive')}
          </tbody>
        </table>

        <div class="demo-readout">
          ${conflictIdx.length ? `
            <b>符号冲突位置：</b>${conflictIdx.join(', ')}<br>
            这些位置上 TIES 保留的平均幅值 <b>${magOf(merged, conflictIdx)}</b>，
            朴素平均只剩 <b>${magOf(naive, conflictIdx)}</b>
            — 朴素平均把两个模型的意图<b>互相抵消</b>了。
          ` : '当前没有符号冲突位置，点「随机生成」试试。'}
          <br><br>
          <b>为什么这重要：</b>合并多个微调模型时，同一参数位置上不同模型往往想要相反的调整。
          直接相加会抵消，TIES 通过符号选举保留占优方向的完整幅度。
        </div>`;
    },
  };

  /* ==================== 初始化 ==================== */

  function init() {
    // Tab 切换
    $$('[data-demo-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = tab.dataset.demoTab;
        $$('[data-demo-tab]').forEach((t) => t.classList.toggle('active', t === tab));
        $$('.demo-panel').forEach((p) => (p.hidden = p.dataset.demo !== id));
        history.replaceState(null, '', '#' + id);
      });
    });

    Attention.init();
    Backprop.init();
    KVCache.init();
    Ties.init();

    // 按 hash 打开对应 demo
    const h = location.hash.slice(1);
    if (h) {
      const tab = $(`[data-demo-tab="${h}"]`);
      if (tab) tab.click();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
