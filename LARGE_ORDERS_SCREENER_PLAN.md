# 大单量价监控筛选器 (Large Orders Screener) - MVP 开发计划

## 1. 产品范围定义 (Scope)

### 包含在 MVP 内的特性 (In Scope)
*   **大单挂单监控**：显示最近 N 分钟内出现的买/卖大单。
*   **量价数据关联**：展示大单对应股票的今日开盘价、最新价、日内总成交量。
*   **基础筛选**：支持按“大单挂单量最小值”、“股票日内总成交量最小值”、“买卖方向”进行筛选。
*   **自动刷新**：页面每隔一定时间（如 5 秒）自动拉取最新数据。

### 不做的清单 (Out of Scope)
*   **不修改现有核心逻辑**：不改动 `daily_summary` 的生成逻辑，不改动 `rankingCache`，不影响原有报警功能。
*   **不做全市场深度挂单扫描**：不扫描 `l2_order_book_*` 原始表，只使用 `l2_large_orders_bl`。
*   **不做历史数据查询**：只监控当天的实时/最近数据。
*   **不做复杂的图表可视化**：只用基础的 HTML 表格展示。
*   **不做用户身份认证与状态持久化**：筛选条件刷新或关闭页面即丢失。

---

## 2. 开发步骤 (小步快跑)

### 准备工作：Git 状态管理
*   **要做什么**：确保当前工作区干净，创建一个新的功能分支（可选，或直接在 master 提交）。
*   **命令**：`git status` (应显示 working tree clean)

---

### Step 1: 新增后端 API 接口
*   **要做什么**：
    在 `src/server.js` 中新增一个 API 路由 `GET /api/large-orders-screener`。
    该接口接收前端传入的筛选参数（`min_order_volume`, `side`, `min_total_volume`, `time_window_mins`）。
    执行 SQL 查询：将 `l2_large_orders_bl` (最近 N 分钟数据) 与 `daily_summary` (今日数据) 进行 `JOIN`。
*   **涉及文件**：`src/server.js`
*   **代码片段**：
    ```javascript
    app.get('/api/large-orders-screener', async (req, res) => {
      try {
        const minOrderVolume = Number(req.query.min_order_volume || 1000);
        const side = req.query.side || 'all'; // 'bid', 'ask', or 'all'
        const minTotalVolume = Number(req.query.min_total_volume || 0);
        const timeWindowMins = Number(req.query.time_window_mins || 5);

        let sideFilter = '';
        if (side === 'bid') sideFilter = "AND o.side = 'bid'";
        if (side === 'ask') sideFilter = "AND o.side = 'ask'";

        const sql = \`
          WITH recent_large_orders AS (
            SELECT DISTINCT ON (stock_code, side)
                stock_code AS symbol, side, level, price AS order_price, volume AS order_volume, detected_at
            FROM l2_large_orders_bl
            WHERE detected_at >= NOW() - ($1 || ' minutes')::interval
              AND volume >= $2
              \${sideFilter}
            ORDER BY stock_code, side, detected_at DESC
          )
          SELECT o.symbol, o.side, o.level, o.order_price, o.order_volume, o.detected_at,
                 d.open_price, d.close_price AS current_price, d.total_volume
          FROM recent_large_orders o
          JOIN market_data.daily_summary d ON o.symbol = d.symbol
          WHERE d.trade_date = CURRENT_DATE
            AND d.total_volume >= $3
          ORDER BY o.detected_at DESC
          LIMIT 100
        \`;

        const { rows } = await pool.query(sql, [timeWindowMins, minOrderVolume, minTotalVolume]);
        res.json(rows);
      } catch (e) {
        console.error('Large orders screener error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
    ```
*   **如何验证**：
    启动服务器后，使用 curl 或浏览器访问：
    `curl "http://localhost:8889/api/large-orders-screener?min_order_volume=1000&time_window_mins=60"`
*   **DoD (完成定义)**：接口返回 200 OK 状态码，并输出符合预期格式的 JSON 数组（包含 `symbol`, `order_price`, `current_price` 等字段）。若成功，执行 `git commit -am "feat: add large orders screener API"`。

---

### Step 2: 创建前端页面与路由
*   **要做什么**：
    1. 在 `public/` 目录下新建 `large-orders.html`。
    2. 在 `src/server.js` 中添加静态页面路由 `app.get('/large-orders', ...)`。
*   **涉及文件**：`public/large-orders.html` (新建), `src/server.js`
*   **代码片段** (server.js):
    ```javascript
    app.get('/large-orders', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/large-orders.html'));
    });
    ```
    **代码片段** (public/large-orders.html 骨架):
    ```html
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <title>大单监控筛选</title>
        <style>
            body { font-family: sans-serif; background: #1a1a1a; color: #ddd; padding: 20px; }
            .container { max-width: 1200px; margin: 0 auto; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { padding: 10px; border: 1px solid #444; text-align: left; }
            th { background: #333; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>大单监控筛选 (大单表 + 今日量价)</h2>
            <!-- Step 3 会在这里加过滤表单 -->
            <table>
                <thead>
                    <tr>
                        <th>股票代码</th>
                        <th>方向</th>
                        <th>挂单价</th>
                        <th>最新价</th>
                        <th>挂单量</th>
                        <th>日总成交量</th>
                        <th>发现时间</th>
                    </tr>
                </thead>
                <tbody id="table-body">
                    <tr><td colspan="7">加载中...</td></tr>
                </tbody>
            </table>
        </div>
    </body>
    </html>
    ```
*   **如何验证**：
    浏览器访问 `http://localhost:8889/large-orders`。
*   **DoD (完成定义)**：页面成功加载，无 404 错误，显示页面骨架和“加载中...”的表格。成功后 `git commit -am "feat: add large orders HTML skeleton"`。

---

### Step 3: 前端数据获取与渲染 (含自动刷新)
*   **要做什么**：
    在 `large-orders.html` 中编写 JavaScript，调用 Step 1 创建的 API，将返回的数据渲染到表格中，并设置定时器自动刷新。
*   **涉及文件**：`public/large-orders.html`
*   **代码片段** (添加到 `large-orders.html` 的 `<body>` 底部):
    ```html
    <script>
        async function fetchData() {
            try {
                // 暂时使用硬编码参数测试，下一步再做动态表单
                const res = await fetch('/api/large-orders-screener?min_order_volume=1000&time_window_mins=60');
                if (!res.ok) throw new Error('Network response error');
                const data = await res.json();
                renderTable(data);
            } catch (err) {
                console.error('Fetch error:', err);
                document.getElementById('table-body').innerHTML = \`<tr><td colspan="7" style="color:red;">加载失败: \${err.message}</td></tr>\`;
            }
        }

        function renderTable(data) {
            const tbody = document.getElementById('table-body');
            if (data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;">暂无符合条件的大单数据</td></tr>';
                return;
            }
            
            let html = '';
            data.forEach(row => {
                const sideColor = row.side === 'bid' ? '#26a69a' : '#ef5350';
                const sideText = row.side === 'bid' ? '买盘' : '卖盘';
                const timeStr = new Date(row.detected_at).toLocaleTimeString();
                
                html += \`
                    <tr>
                        <td style="font-weight:bold;">\${row.symbol}</td>
                        <td style="color:\${sideColor};">\${sideText} (L\${row.level})</td>
                        <td>\${Number(row.order_price).toFixed(2)}</td>
                        <td>\${Number(row.current_price).toFixed(2)}</td>
                        <td>\${row.order_volume}</td>
                        <td>\${row.total_volume}</td>
                        <td style="color:#888;">\${timeStr}</td>
                    </tr>
                \`;
            });
            tbody.innerHTML = html;
        }

        // 初始加载与自动刷新
        fetchData();
        setInterval(fetchData, 5000); // 每 5 秒刷新一次
    </script>
    ```
*   **如何验证**：
    浏览器访问 `http://localhost:8889/large-orders`，观察控制台 (Console) 是否有报错，表格是否显示了实际的数据库数据，并且每 5 秒自动请求一次。
*   **DoD (完成定义)**：真实数据成功渲染在表格中，买卖方向颜色区分正确。成功后 `git commit -am "feat: implement data fetching and rendering"`。

---

### Step 4: 增加动态过滤与表单绑定
*   **要做什么**：
    在 HTML 中添加输入框（最小挂单量、最小总成交量、时间窗口），并利用 JS 获取输入框的值来动态拼接 `fetch` 的 URL。使用防抖 (Debounce) 避免频繁请求。
*   **涉及文件**：`public/large-orders.html`
*   **代码片段**：
    在 HTML 中 `<table>` 上方添加控制面板：
    ```html
    <div style="margin-bottom: 15px; background: #2a2a2a; padding: 15px; border-radius: 5px;">
        <label>最小挂单量: <input type="number" id="min-order-vol" value="1000"></label>
        <label style="margin-left:15px;">日总成交量: <input type="number" id="min-total-vol" value="0"></label>
        <label style="margin-left:15px;">监控时间窗口(分钟): <input type="number" id="time-window" value="60"></label>
        <label style="margin-left:15px;">方向: 
            <select id="side-filter">
                <option value="all">全部</option>
                <option value="bid">只看买盘</option>
                <option value="ask">只看卖盘</option>
            </select>
        </label>
    </div>
    ```
    修改 JS 逻辑：
    ```javascript
    let fetchTimer;
    
    function buildUrl() {
        const minOrderVol = document.getElementById('min-order-vol').value || 0;
        const minTotalVol = document.getElementById('min-total-vol').value || 0;
        const timeWindow = document.getElementById('time-window').value || 5;
        const side = document.getElementById('side-filter').value;
        return \`/api/large-orders-screener?min_order_volume=\${minOrderVol}&min_total_volume=\${minTotalVol}&time_window_mins=\${timeWindow}&side=\${side}\`;
    }

    async function fetchData() {
        try {
            const res = await fetch(buildUrl());
            if (!res.ok) throw new Error('Network error');
            const data = await res.json();
            renderTable(data);
        } catch (err) {
            console.error(err);
        }
    }

    // 绑定事件 (添加防抖或直接在失去焦点时触发)
    ['min-order-vol', 'min-total-vol', 'time-window', 'side-filter'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => {
            fetchData();
            // 重置定时器
            clearInterval(fetchTimer);
            fetchTimer = setInterval(fetchData, 5000);
        });
    });

    fetchData();
    fetchTimer = setInterval(fetchData, 5000);
    ```
*   **如何验证**：
    在浏览器中修改输入框的数值（例如把最小挂单量改成 5000），观察表格数据是否立即刷新并过滤掉不符合条件的记录。
*   **DoD (完成定义)**：表单输入实时生效，接口请求参数正确，UI 数据更新无闪烁。成功后 `git commit -am "feat: add dynamic filters to large orders screener"`。
