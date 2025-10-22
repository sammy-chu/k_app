# K线图 Y 轴自动适配（Canvas）MVP 实施指南

> 目标：在 `canvas` 上实现根据可见窗口数据自动调整纵轴范围，保证每个蜡烛（含影线）完整显示，遵循 MVP、小步快跑与范围控制。

---

## 范围与“不做”清单
- 本迭代只实现：
  - 固定数据窗口的 K 线基础渲染（蜡烛+影线）。
  - 基于可见窗口的 Y 轴自动适配（含 padding、tickSize 对齐）。
  - 简单刻度渲染与像素缓冲。
- 不做：
  - 高级交互（平滑动画、拖拽、鼠标十字线、手势缩放）。
  - 复杂指标（均线、MACD、成交量柱状图等）。
  - WebGL/高性能虚拟化/多图联动。
  - 实时推送与订阅（只用已有 REST `/api/ohlcv` 拉取）。
  - 多品种多日期切换的完整 UI（只保留简易输入）。

---

## 项目结构与将要修改/新增的文件
- `public/kline.html`（新增）：K 线页面与 `<canvas>`、输入控件。
- `public/js/kline.js`（新增）：K 线渲染与 Y 轴自动适配逻辑。
- `src/server.js`（无需改动）：已提供静态文件与 `/api/ohlcv` 接口。

---

## Git 使用策略（建议）
- 每个功能从干净状态开始：`git status` 确认无未提交改动。
- 失败时果断重置：`git restore -SW .` 或 `git reset --hard`（谨慎使用）。
- 每一步完成且通过验证后再提交：`git add -A && git commit -m "feat: <step name>"`。

---

## 预备步骤（Step 0）
- 要做什么：确认服务可启动、接口可访问。
- 如何验证：
  - 终端：`npm install && npm start`
  - 浏览器访问：`http://localhost:3000/health`
  - Curl：`curl http://localhost:3000/api/ohlcv?symbol=AMD&date=2024-10-07`
- DoD：
  - 服务器启动成功（终端打印 `Server listening on http://localhost:3000`）。
  - `/health` 返回 `{ ok: true }`。
  - `/api/ohlcv` 返回含有 `t, o, h, l, c, v` 字段的 JSON 列表。

---

## 步骤一：新增 K 线页面与基础渲染（固定比例）
- 要做什么：创建 `public/kline.html` 与 `public/js/kline.js`，用固定 Y 轴比例绘制蜡烛，确保基础绘制正确。
- 修改的文件与代码片段：
  - `public/kline.html`（新增）
    ```html
    <!doctype html>
    <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Canvas K线（MVP）</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
        .toolbar { margin-bottom: 8px; display: flex; gap: 8px; align-items: center; }
        canvas { border: 1px solid #e0e0e0; }
      </style>
    </head>
    <body>
      <div class="toolbar">
        <label>Symbol <input id="sym" value="AMD" /></label>
        <label>Date <input id="date" type="date" /></label>
        <label>Bars <input id="bars" type="number" min="20" max="200" value="80" /></label>
        <button id="load">加载</button>
      </div>
      <canvas id="chart" width="1024" height="480"></canvas>
      <script src="/js/kline.js"></script>
    </body>
    </html>
    ```
  - `public/js/kline.js`（新增，基础渲染骨架）
    ```js
    async function fetchOHLCV(symbol, date) {
      const url = `/api/ohlcv?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('fetch failed');
      return res.json();
    }

    function drawBaseCandles(ctx, canvas, data) {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // 固定比例（仅用于验证绘制），后续用自动适配替换
      const fixedMin = Math.min(...data.map(d => Number(d.l)));
      const fixedMax = Math.max(...data.map(d => Number(d.h)));
      const yScale = H / (fixedMax - fixedMin);
      const pxPerBar = Math.max(4, Math.floor(W / data.length));

      data.forEach((d, i) => {
        const o = Number(d.o), h = Number(d.h), l = Number(d.l), c = Number(d.c);
        const x = i * pxPerBar + Math.floor(pxPerBar / 2);
        const color = c >= o ? '#18a058' : '#d03050';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        // 价格到像素（顶部为 0）
        const y = (p) => (fixedMax - p) * yScale;
        // 影线
        ctx.beginPath();
        ctx.moveTo(x, y(h));
        ctx.lineTo(x, y(l));
        ctx.stroke();
        // 实体
        const bodyTop = y(Math.max(o, c));
        const bodyBot = y(Math.min(o, c));
        const bodyW = Math.max(3, pxPerBar - 2);
        ctx.fillRect(x - Math.floor(bodyW / 2), bodyTop, bodyW, Math.max(1, bodyBot - bodyTop));
      });
    }

    async function main() {
      const symEl = document.getElementById('sym');
      const dateEl = document.getElementById('date');
      const barsEl = document.getElementById('bars');
      const loadBtn = document.getElementById('load');
      const canvas = document.getElementById('chart');
      const ctx = canvas.getContext('2d');

      // 默认日期为今天
      const today = new Date();
      dateEl.value = today.toISOString().slice(0, 10);

      async function load() {
        const symbol = symEl.value.trim();
        const date = dateEl.value;
        const bars = Math.max(20, Math.min(200, Number(barsEl.value) || 80));
        const rows = await fetchOHLCV(symbol, date);
        const data = rows.slice(-bars);
        drawBaseCandles(ctx, canvas, data);
      }

      loadBtn.addEventListener('click', load);
      await load();
    }

    main().catch(console.error);
    ```
- 如何验证：
  - 浏览器访问：`http://localhost:3000/kline.html`，默认加载今日数据，看到蜡烛绘制（比例暂不自适应）。
  - 控件修改 `Bars`，蜡烛数量变化但不报错。
- DoD：
  - 能绘制一组蜡烛与影线，颜色正确（阳线绿/阴线红）。
  - 页面加载与按钮交互无错误。

---

## 步骤二：加入 Y 轴自动适配（Fit-to-Data + padding）
- 要做什么：对当前可见窗口数据计算 `highestHigh/lowestLow`，加入 `padPercent` 与 `tickSize` 对齐，得到 `yMin/yMax/yScale` 替换固定比例。
- 修改的文件与代码片段：
  - `public/js/kline.js`：添加自动适配函数并替换绘制使用的比例
    ```js
    // 建议参数
    const padPercent = 0.08;      // 8% 额外缓冲
    const minPadTicks = 3;        // 至少 3 个最小跳动
    const tickSize = 0.01;        // 股票最小价位单位（按需调整）

    function roundUpToTick(x, tick) {
      return Math.ceil(x / tick) * tick;
    }
    function roundDownToTick(x, tick) {
      return Math.floor(x / tick) * tick;
    }

    function computeYAxis(data, H) {
      const highs = data.map(d => Number(d.h));
      const lows  = data.map(d => Number(d.l));
      const highestHigh = Math.max(...highs);
      const lowestLow   = Math.min(...lows);
      const priceRange = Math.max(1e-9, highestHigh - lowestLow);
      const padByPct = padPercent * priceRange;
      const padByTicks = minPadTicks * tickSize;
      const pad = Math.max(padByPct, padByTicks);

      let yMax = roundUpToTick(highestHigh + pad, tickSize);
      let yMin = roundDownToTick(lowestLow  - pad, tickSize);
      const yRange = Math.max(tickSize, yMax - yMin);
      const yScale = H / yRange;
      return { yMin, yMax, yScale };
    }

    function drawCandlesAuto(ctx, canvas, data) {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const { yMin, yMax, yScale } = computeYAxis(data, H);
      const pxPerBar = Math.max(4, Math.floor(W / data.length));
      const y = (p) => (yMax - p) * yScale; // 顶部为 0

      data.forEach((d, i) => {
        const o = Number(d.o), h = Number(d.h), l = Number(d.l), c = Number(d.c);
        const x = i * pxPerBar + Math.floor(pxPerBar / 2);
        const color = c >= o ? '#18a058' : '#d03050';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        // 影线
        ctx.beginPath();
        ctx.moveTo(x, y(h));
        ctx.lineTo(x, y(l));
        ctx.stroke();
        // 实体
        const bodyTop = y(Math.max(o, c));
        const bodyBot = y(Math.min(o, c));
        const bodyW = Math.max(3, pxPerBar - 2);
        ctx.fillRect(x - Math.floor(bodyW / 2), bodyTop, bodyW, Math.max(1, bodyBot - bodyTop));
      });
    }

    // 在 main() 中：将 drawBaseCandles 替换成 drawCandlesAuto
    // drawCandlesAuto(ctx, canvas, data);
    ```
- 如何验证：
  - 浏览器：`http://localhost:3000/kline.html`，改变 `Bars`（如 40/80/120），观察 Y 轴范围随数据窗口变化，影线与实体均未被裁剪。
- DoD：
  - 任意可见窗口内的最低/最高包含在画布内，且上下留有可视化缓冲。

---

## 步骤三：防抖与阈值重算，减少抖动
- 要做什么：快速多次加载/滚动时，限制 Y 轴频繁重算；仅当新极值超出当前边界的阈值才更新。
- 修改的文件与代码片段：
  - `public/js/kline.js`：加入简单防抖与阈值判断
    ```js
    let lastAxis = null;
    const recomputeThreshold = 0.5; // 当极值突破当前 pad 的 50% 才重算
    const debounceMs = 80;
    let timer = null;

    function shouldRecompute(data, lastAxis) {
      if (!lastAxis) return true;
      const highestHigh = Math.max(...data.map(d => Number(d.h)));
      const lowestLow   = Math.min(...data.map(d => Number(d.l)));
      const pad = (lastAxis.yMax - lastAxis.yMin) * padPercent;
      const exceedTop = highestHigh > (lastAxis.yMax - pad * (1 - recomputeThreshold));
      const exceedBot = lowestLow  < (lastAxis.yMin + pad * (1 - recomputeThreshold));
      return exceedTop || exceedBot;
    }

    function drawCandlesAutoStable(ctx, canvas, data) {
      const W = canvas.width, H = canvas.height;
      const need = shouldRecompute(data, lastAxis);
      if (need) lastAxis = computeYAxis(data, H);
      const { yMin, yMax, yScale } = lastAxis;

      ctx.clearRect(0, 0, W, H);
      const pxPerBar = Math.max(4, Math.floor(W / data.length));
      const y = (p) => (yMax - p) * yScale;
      // 同上绘制...
      data.forEach((d, i) => { /* 影线+实体绘制同前 */ });
    }

    // 加载时：
    async function loadDebounced(loader) {
      clearTimeout(timer);
      await new Promise(r => { timer = setTimeout(r, debounceMs); });
      return loader();
    }
    ```
- 如何验证：
  - 连续点击“加载”或快速改变 `Bars`，观察纵轴不出现明显闪跳；仅在窗口极值确实变化较大时调整。
- DoD：
  - 快速交互下图表仍稳定；纵轴更新频率明显下降但不影响包含极值。

---

## 步骤四：Y 轴刻度与可读性（nice number + tickSize 对齐）
- 要做什么：根据画布高度估算刻度数量，计算“好看”的刻度步长，并与 `tickSize` 对齐，绘制网格与价格标签。
- 修改的文件与代码片段：
  - `public/js/kline.js`：刻度计算与绘制
    ```js
    function niceStep(range, targetTicks) {
      const rough = range / Math.max(1, targetTicks);
      const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
      const candidates = [1, 2, 2.5, 5, 10].map(m => m * pow10);
      let step = candidates.reduce((best, c) => Math.abs(c - rough) < Math.abs(best - rough) ? c : best, candidates[0]);
      // 与 tickSize 对齐
      const factor = Math.max(1, Math.round(step / tickSize));
      return factor * tickSize;
    }

    function drawYAxis(ctx, canvas, yMin, yMax, yScale) {
      const H = canvas.height, W = canvas.width;
      const minTickPixel = 40;
      const targetTicks = Math.max(2, Math.floor(H / minTickPixel));
      const step = niceStep(yMax - yMin, targetTicks);
      const start = roundUpToTick(yMin, step);

      ctx.strokeStyle = '#eee';
      ctx.fillStyle = '#666';
      ctx.font = '12px system-ui';
      for (let p = start; p <= yMax + 1e-9; p += step) {
        const y = (yMax - p) * yScale;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
        ctx.fillText(p.toFixed(Math.max(0, String(step).split('.')[1]?.length || 0)), 4, Math.max(12, y - 2));
      }
    }

    // 在绘制蜡烛后调用：drawYAxis(ctx, canvas, yMin, yMax, yScale);
    ```
- 如何验证：
  - 浏览器中观察 Y 轴网格与价格标签，刻度间距在 30–50 像素之间，标签对齐精度与 `tickSize` 一致。
- DoD：
  - 刻度与网格显示清晰、数量合理；价格标签无重叠、精度符合预期。

---

## 步骤五：最近 N 根视窗与双击复位（可选的小步）
- 要做什么：只对最近 `N` 根做自动适配，提供双击画布复位当前视窗。
- 修改的文件与代码片段：
  - `public/js/kline.js`
    ```js
    let barsN = 80; // 与输入框联动
    let fullData = [];

    function setWindow(data, n) { return data.slice(-n); }

    function enableDoubleClickReset(canvas, render) {
      canvas.addEventListener('dblclick', () => {
        lastAxis = null; // 清空以强制重算
        render();
      });
    }
    ```
- 如何验证：
  - 选择不同 `Bars` 后图表稳定；双击画布可复位纵轴并重新适配。
- DoD：
  - 视窗切换与复位工作正常；纵轴包含当前窗口极值并留有缓冲。

---

## 终验（End-to-End）
- 要做什么：以真实数据完成一整套流程体验。
- 如何验证：
  - `npm start` 启动服务。
  - 浏览器访问：`http://localhost:3000/kline.html?symbol=AMD&date=2024-10-07`（也可通过页面输入栏设置）。
  - 观察：蜡烛完整显示、纵轴自动适配、刻度可读、快速交互不抖动。
- DoD：
  - 针对不同 `Bars` 数、不同日期、不同品种（如 `AAPL`）均满足“蜡烛完整显示、纵轴留有缓冲”的要求。

---

## 备注与后续可迭代方向
- 若数据包含极端影线导致实体变得很小，可在 `computeYAxis` 中加入分位数保护：先用 P1/P99 初算范围，再在单侧对极值增量扩展。
- 设备像素比与线宽的像素缓冲：`extraPad = (lineWidth/2 * devicePixelRatio) / yScale` 可叠加到 `pad`。
- 性能：当数据量更大时，可对数据分段预聚合极值，当前 MVP 不做。

---

## 回滚与故障处理
- 若某步实现失败或效果不佳：
  - 回滚：`git restore -SW .` 或 `git reset --hard`。
  - 恢复：回到上一步的提交，从干净状态重试。

---

## 附：现有服务脚本与接口
- 启动服务：`npm start`（`src/server.js`，静态目录 `public/`）。
- 健康检查：`GET /health`。
- OHLCV 数据：`GET /api/ohlcv?symbol=<SYM>&date=<YYYY-MM-DD>`（返回 `t,o,h,l,c,v`）。