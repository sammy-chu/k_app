const { Pool } = require('pg');

// 独立运行时使用的连接池配置
const dbConfig = {
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres'
};

/**
 * 核心策略函数：寻找宽幅/多周期山丘
 *
 * [FIX-A] 改用独立 client 执行所有查询，设置 statement_timeout = 20000
 * [FIX-B] 获取最新日期改为范围查询，避免全表 MAX 扫描
 * [FIX-C] 主查询 WHERE 改为范围写法，让 idx_tos_trades_symbol_received 索引生效
 * [FIX-D] 山丘边界检测循环移除多余的指针增减，直接 break
 */
async function getFlexibleHills(pool, dateStr) {
  // [FIX-A] 使用独立 client，所有查询在同一连接上执行，统一设置 timeout
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO ' + (process.env.PGSCHEMA || 'market_data'));
    await client.query('SET statement_timeout = 20000');

    // ── 1. 确定目标日期 ──────────────────────────────────────────
    let targetDate = dateStr;
    if (!targetDate) {
      // [FIX-B] 加 WHERE 范围条件，避免对 113 万行做全表 MAX 扫描
      const dateRes = await client.query(`
        SELECT MAX(received_at)::date AS last_date
        FROM tos_trades
        WHERE received_at >= NOW() - INTERVAL '7 days'
      `);
      targetDate = dateRes.rows[0].last_date;
      if (!targetDate) {
        targetDate = new Date().toISOString().split('T')[0];
      }
    }

    // ── 2. 一次性拉取当日所有 symbol 的分钟数据 ─────────────────
    const minuteRes = await client.query(`
      SELECT
        t.symbol,
        date_trunc('minute', t.received_at)  AS bucket,
        SUM(t.size)::numeric                 AS volume,
        AVG(t.price::numeric)                AS avg_price
      FROM tos_trades t
      JOIN user_symbols u ON u.symbol = t.symbol
      WHERE t.received_at >= $1::date
        AND t.received_at <  $1::date + INTERVAL '1 day'
        AND t.size  IS NOT NULL AND t.size::numeric  > 0
        AND t.price IS NOT NULL AND t.price::numeric > 0
      GROUP BY t.symbol, date_trunc('minute', t.received_at)
      ORDER BY t.symbol, date_trunc('minute', t.received_at)
    `, [targetDate]);
    // [FIX-C] 范围写法替代 DATE(received_at) = $1，让索引生效

    if (minuteRes.rows.length === 0) {
      return { date: targetDate, count: 0, data: [] };
    }

    // ── 3. 按 symbol 分组 ────────────────────────────────────────
    const symbolMap = new Map();
    for (const row of minuteRes.rows) {
      const sym = row.symbol;
      if (!symbolMap.has(sym)) symbolMap.set(sym, []);
      symbolMap.get(sym).push({
        t: row.bucket,
        v: Number(row.volume),
        p: Number(row.avg_price),
      });
    }

    // ── 4. 对每个 symbol 计算 baseline + 检测 peaks + 提取山丘 ──
    const results = [];

    for (const [symbol, bars] of symbolMap) {
      // bars 已按 bucket ASC 排序（SQL ORDER BY 保证）

      // 4a. 计算每根 bar 的 baseline = 前 20 根均量（不含当前根）
      const baselines = bars.map((_, i) => {
        if (i === 0) return 0;
        const start  = Math.max(0, i - 20);
        const window = bars.slice(start, i);
        return window.reduce((s, b) => s + b.v, 0) / window.length;
      });

      // 4b. 遍历每根 bar，找满足条件的 peak
      for (let i = 2; i < bars.length; i++) {
        const bar      = bars[i];
        const baseline = baselines[i];
        const v_m1     = bars[i - 1].v;
        const v_m2     = bars[i - 2].v;

        if (
          bar.v > 1000 &&
          bar.v * bar.p > 50000 &&
          baseline > 0 &&
          bar.v > baseline * 3 &&
          bar.v > v_m1 &&
          bar.v > v_m2
        ) {
          const peakVol     = bar.v;
          const windowStart = Math.max(0, i - 15);
          const windowEnd   = Math.min(bars.length - 1, i + 15);

          // 4c. 向左找山丘左边界
          // [FIX-D] 移除多余的 leftIndex--，到达边界时直接 break，不多走一步
          let leftIndex = i;
          while (leftIndex > windowStart) {
            const prev = bars[leftIndex - 1].v;
            if (prev < peakVol * 0.3 || prev < baseline) break;
            if (prev > bars[leftIndex].v) break;
            leftIndex--;
          }

          // 4d. 向右找山丘右边界
          // [FIX-D] 移除多余的 rightIndex++，到达边界时直接 break，不多走一步
          let rightIndex = i;
          while (rightIndex < windowEnd) {
            const next = bars[rightIndex + 1].v;
            if (next < peakVol * 0.3 || next < baseline) break;
            if (next > bars[rightIndex].v) break;
            rightIndex++;
          }

          const duration = rightIndex - leftIndex + 1;
          if (duration < 4) continue;

          // 4e. 计算饱满度
          let totalVol = 0;
          for (let j = leftIndex; j <= rightIndex; j++) totalVol += bars[j].v;
          const fullness = totalVol / (peakVol * duration);

          results.push({
            symbol,
            peakTime:  bar.t,
            startTime: bars[leftIndex].t,
            endTime:   bars[rightIndex].t,
            peakVol,
            baseline,
            ratio:    peakVol / (baseline || 1),
            duration,
            fullness,
            shape: bars.slice(leftIndex, rightIndex + 1).map(b => b.v),
          });
        }
      }
    }

    // ── 5. 按 peakTime 降序排列（最新的在前）────────────────────
    results.sort((a, b) => new Date(b.peakTime) - new Date(a.peakTime));

    return {
      date:  targetDate,
      count: results.length,
      data:  results,
    };

  } finally {
    client.release();
  }
}

// ── 独立运行入口 ─────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const pool = new Pool(dbConfig);
    try {
      const result = await getFlexibleHills(pool);
      console.log(`=== 扫描日期: ${result.date} 的宽幅/多周期山丘形放量 ===`);

      if (result.count === 0) {
        console.log('未找到符合条件的宽幅山丘。');
      } else {
        console.log(`\n找到 ${result.count} 个山丘 (按时间降序):\n`);
        console.log(
          'Symbol'.padEnd(10) +
          'Time Range'.padEnd(36) +
          'Peak Vol'.padEnd(10) +
          'Dur'.padEnd(6) +
          'Ratio'.padEnd(8) +
          'Full'.padEnd(6) +
          'Shape'
        );
        console.log('-'.repeat(120));

        result.data.slice(0, 100).forEach(r => {
          const fmt = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const timeRange    = `${fmt(r.startTime)}-${fmt(r.endTime)} (P:${fmt(r.peakTime)})`;
          const shapePreview = r.shape.length > 7
            ? `${r.shape[0]}...${r.peakVol}...${r.shape[r.shape.length - 1]}`
            : r.shape.join('-');

          console.log(
            r.symbol.padEnd(10) +
            timeRange.padEnd(36) +
            String(r.peakVol).padEnd(10) +
            String(r.duration).padEnd(6) +
            String(r.ratio.toFixed(1) + 'x').padEnd(8) +
            String(r.fullness.toFixed(2)).padEnd(6) +
            shapePreview
          );
        });
      }
    } catch (e) {
      console.error(e);
    } finally {
      await pool.end();
    }
  })();
}

module.exports = { getFlexibleHills };