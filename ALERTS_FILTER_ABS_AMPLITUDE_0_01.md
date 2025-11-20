# ALERTS 页面筛选振幅绝对值≥0.01 前端实现步骤

- 范围：仅前端 `public/alerts.html`，不改后端和接口
- 目标：在页面仅展示 `|amplitude_pct| >= 0.01` 的告警记录
- 约束：不添加任何状态统计展示区域（例如“已筛选：12/120”）

---

## 步骤 1：添加筛选控件

- 要做什么
  - 在 `public/alerts.html` 增加两个控件：
    - 数值输入框：设置振幅绝对值阈值，默认 `0.01`
    - 复选框：是否启用筛选，默认启用
  - 不增加任何统计展示区域
- 需要修改的文件
  - `public/alerts.html`
- 代码片段（插入到 `<body>` 中合适位置，例如表格/列表上方）

```html
<div id="filter-controls" style="margin-bottom: 8px;">
  <label>
    振幅阈值(绝对值)：
    <input id="amp-threshold" type="number" step="0.001" min="0" value="0.01" style="width: 120px;">
  </label>
  <label style="margin-left: 12px;">
    <input id="amp-filter-enabled" type="checkbox" checked>
    仅显示超过阈值
  </label>
</div>
```

- 如何验证
  - 浏览器访问 `http://localhost:8889/alerts`，确认看到两个控件（输入框与复选框）
  - 控件显示正常，无控制台错误
- DoD（完成定义）
  - 页面出现上述两个控件，默认阈值为 `0.01` 且默认勾选“仅显示超过阈值”
  - 无新增视觉统计区域（如“已筛选：12/120”）出现

---

## 步骤 2：在渲染前应用筛选逻辑

- 要做什么
  - 在现有获取 `/api/alerts` 的流程中，渲染前对数据进行过滤：
    - 当启用筛选时，仅保留 `Math.abs(Number(amplitude_pct)) >= 阈值` 的记录
    - 当关闭筛选时，显示全部记录
  - 对异常值做兜底（`null/undefined/NaN` 当作不满足条件）
- 需要修改的文件
  - `public/alerts.html`
- 代码片段（插入到页面脚本 `<script>` 中，或合并到现有渲染逻辑）

```html
<script>
  (function () {
    const DEFAULT_THRESHOLD = 0.01;

    const els = {
      threshold: document.getElementById('amp-threshold'),
      enabled: document.getElementById('amp-filter-enabled'),
      // 假设页面已有渲染容器，以下 ID 请替换为你实际的容器 ID
      table: document.getElementById('alerts-table') || document.getElementById('alerts-list'),
    };

    const state = {
      threshold: DEFAULT_THRESHOLD,
      enabled: true,
    };

    // 读取URL参数与localStorage（后续步骤会详细说明）
    initSettingsFromEnv();

    function safeNum(x) {
      const n = Number(x);
      return Number.isFinite(n) ? n : 0;
    }

    function applyFilter(list, threshold, enabled) {
      if (!enabled) return list;
      const t = Number.isFinite(threshold) && threshold >= 0 ? threshold : DEFAULT_THRESHOLD;
      return list.filter(item => Math.abs(safeNum(item?.amplitude_pct)) >= t);
    }

    async function fetchAlerts() {
      const res = await fetch('/api/alerts', { cache: 'no-store' });
      if (!res.ok) throw new Error('alerts api failed: ' + res.status);
      return res.json();
    }

    function renderAlerts(list) {
      // 根据你的页面结构进行渲染，这里示例为简单的表格行生成
      // 不添加任何统计区域
      if (!els.table) return;
      const rows = list.map(a => `
        <tr>
          <td>${a.symbol ?? ''}</td>
          <td>${new Date(a.bucket).toLocaleString()}</td>
          <td>${safeNum(a.open).toFixed(2)}</td>
          <td>${safeNum(a.high).toFixed(2)}</td>
          <td>${safeNum(a.low).toFixed(2)}</td>
          <td>${safeNum(a.close).toFixed(2)}</td>
          <td>${(safeNum(a.amplitude_pct) * 100).toFixed(2)}%</td>
          <td>${a.direction ?? ''}</td>
          <td>${a.rule_id ?? ''}</td>
        </tr>
      `).join('');
      const tbody = els.table.querySelector('tbody') || els.table;
      tbody.innerHTML = rows;
    }

    async function refresh() {
      try {
        const all = await fetchAlerts();
        const filtered = applyFilter(all, state.threshold, state.enabled);
        renderAlerts(filtered);
      } catch (e) {
        console.error('[alerts] refresh failed:', e);
      }
    }

    // 事件绑定
    els.threshold.addEventListener('change', () => {
      const v = Number(els.threshold.value);
      state.threshold = Number.isFinite(v) && v >= 0 ? v : DEFAULT_THRESHOLD;
      saveSettings();
      refresh();
    });
    els.enabled.addEventListener('change', () => {
      state.enabled = !!els.enabled.checked;
      saveSettings();
      refresh();
    });

    // 首次加载与轮询（如页面已有轮询，请合并，不要重复设置）
    refresh();
    // 如需轮询，解开下行注释（避免重复设置）
    // setInterval(refresh, 5000);

    function initSettingsFromEnv() {
      const qs = new URLSearchParams(location.search);
      const ampMinQS = qs.get('amp_min');
      const saved = JSON.parse(localStorage.getItem('alerts_amp_settings') || '{}');

      const initialThreshold = Number(ampMinQS ?? saved.threshold ?? DEFAULT_THRESHOLD);
      state.threshold = Number.isFinite(initialThreshold) && initialThreshold >= 0 ? initialThreshold : DEFAULT_THRESHOLD;
      state.enabled = (saved.enabled ?? true) === true;

      if (els.threshold) els.threshold.value = String(state.threshold);
      if (els.enabled) els.enabled.checked = !!state.enabled;
    }

    function saveSettings() {
      localStorage.setItem('alerts_amp_settings', JSON.stringify({
        threshold: state.threshold,
        enabled: state.enabled,
      }));
    }
  })();
</script>
```

- 如何验证
  - 浏览器访问 `http://localhost:8889/alerts`
    - 打开开发者工具 Console，确认无报错
    - 当勾选“仅显示超过阈值”且阈值为 `0.01` 时，页面上不应出现 `|amplitude_pct| < 0.01` 的记录
    - 取消勾选后，页面应显示全部记录
- DoD（完成定义）
  - 当筛选启用且阈值为 `0.01`，页面仅显示 `|amplitude_pct| >= 0.01` 的记录
  - 当筛选禁用时，页面显示全部记录
  - 异常值（`null/undefined/NaN`）不影响页面稳定性且不会被误显示为满足条件

---

## 步骤 3：支持 URL 参数与持久化（amp_min 与 localStorage）

- 要做什么
  - 支持通过 URL 参数 `amp_min` 设置初始阈值，例如 `http://localhost:8889/alerts?amp_min=0.02`
  - 将用户的阈值与开关存储在 `localStorage`，刷新后保持
- 需要修改的文件
  - `public/alerts.html`
- 代码片段
  - 已在步骤 2 的脚本中包含 `initSettingsFromEnv()` 与 `saveSettings()` 的实现
- 如何验证
  - 浏览器访问 `http://localhost:8889/alerts?amp_min=0.02`，确认输入框初始值为 `0.02`
  - 修改阈值为 `0.03` 并刷新页面，确认仍为 `0.03`
- DoD（完成定义）
  - 支持 `amp_min` URL 参数覆盖默认阈值
  - 本地保存（`localStorage`）的阈值与开关在刷新后仍然生效

---

## 步骤 4：与现有渲染逻辑整合

- 要做什么
  - 将 `renderAlerts(filtered)` 替换或嵌入到页面现有的渲染流程中（如已有表格/列表）
  - 确保不引入重复轮询或重复事件绑定
- 需要修改的文件
  - `public/alerts.html`
- 代码片段

```js
// 若已有 render() 函数，改为：
function render(all) {
  const filtered = applyFilter(all, state.threshold, state.enabled);
  renderAlerts(filtered);
}

// 若已有轮询：
async function poll() {
  const all = await fetchAlerts();
  const filtered = applyFilter(all, state.threshold, state.enabled);
  renderAlerts(filtered);
}
// setInterval(poll, EXISTING_INTERVAL_MS);
```

- 如何验证
  - 浏览器访问 `http://localhost:8889/alerts`，操作阈值与开关后，列表随之正确刷新
  - 保持原有轮询节奏，无多余重复渲染或闪烁
- DoD（完成定义）
  - 与现有代码结构无冲突，页面行为一致且稳定
  - 不出现重复定时器或重复绑定

---

## 步骤 5：API 与页面行为的端到端验证

- 要做什么
  - 验证前端过滤是否正确，不影响后端数据
- 验证命令
  - `curl`（Windows PowerShell 环境也可用）
    - `curl http://localhost:8889/api/alerts`
  - 可选：PowerShell JSON 过滤（验证接口确实返回小于 `0.01` 的数据，以证明过滤发生在前端）

```powershell
Invoke-WebRequest http://localhost:8889/api/alerts | Select-Object -Expand Content | ConvertFrom-Json | ? { [math]::Abs([double]$_.amplitude_pct) -lt 0.01 } | Select-Object -First 5
```

- 浏览器验证
  - 在页面启用筛选且阈值为 `0.01`，确认视觉上已不显示 `|amplitude_pct| < 0.01` 的记录
  - 取消筛选后，重新显示全部记录
- DoD（完成定义）
  - `curl` 返回的原始数据包含未达阈值的记录，而页面在启用筛选时不显示这些记录
  - 页面交互（启用/禁用筛选、调整阈值）立即生效，无错误日志

---

## 步骤 6：健壮性与边界值检查

- 要做什么
  - 阈值输入为非法值（负数、非数），回退为默认 `0.01`
  - 阈值非常大（例如 `> 1`），页面可能显示为空，但不报错
- 需要修改的文件
  - `public/alerts.html`
- 代码片段（校验已在 `applyFilter` 与事件处理内处理）
  - 无需额外新增片段
- 如何验证
  - 阈值输入 `-1` 或非数，刷新后阈值回退为 `0.01`，页面正常
  - 阈值输入 `1`（即 100%），列表可能为空但不报错
- DoD（完成定义）
  - 非法输入不会导致脚本错误或页面崩溃
  - 在极端阈值下页面仍保持稳定

---

## 完成后不应出现的内容

- 不要添加任何状态统计展示区域，例如“已筛选：12/120”

---

## 最终验收标准（DoD 总结）

- 页面提供阈值输入与启用筛选开关，默认 `amp_min=0.01` 且筛选启用
- 启用筛选时仅显示 `|amplitude_pct| >= 阈值` 的记录；禁用筛选时显示全部
- 支持通过 URL 参数 `amp_min` 设置初始阈值，并通过 `localStorage` 持久化用户配置
- 无新增统计展示区域
- 控制台与网络面板无报错，接口正常，页面渲染稳定且可用