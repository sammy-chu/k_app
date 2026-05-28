const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

// Mock configuration
const config = {
  get: async (key, defaultVal) => {
    if (key === 'volume_history_days') return 10;
    if (key === 'time_checkpoints') return [
      { elapsed_minutes: 120, expected_pct: 0.30, label: "开市2小时" }, 
      { elapsed_minutes: 180, expected_pct: 0.50, label: "开市3小时" }, 
      { elapsed_minutes: 240, expected_pct: 0.75, label: "收盘前" }
    ];
    return defaultVal;
  }
};

async function testScan(targetDate) {
  try {
    await pool.query('SET search_path TO market_data');
    console.log(`Running scan simulation for date: ${targetDate}`);

    const VOLUME_HISTORY_DAYS = await config.get('volume_history_days', 20);
    let timeCheckpoints = await config.get('time_checkpoints', []);
    
    // Simulate elapsed minutes for 2 hours (120 mins)
    const elapsedMinutes = 120;
    console.log(`Simulating elapsed minutes: ${elapsedMinutes}`);

    for (const cp of timeCheckpoints) {
      if (elapsedMinutes < cp.elapsed_minutes) {
        console.log(`Skipping checkpoint ${cp.label} (requires ${cp.elapsed_minutes} mins)`);
        continue;
      }
      
      const ruleId = `checkpoint_${cp.elapsed_minutes}min_${Math.round(cp.expected_pct*100)}pct`;
      console.log(`Checking rule: ${ruleId} (expected < ${cp.expected_pct})`);

      const sql = `
        WITH hist_ranked AS (
          SELECT symbol,
                 daily_volume,
                 PERCENT_RANK() OVER (PARTITION BY symbol ORDER BY daily_volume) AS pct_rank,
                 COUNT(*) OVER (PARTITION BY symbol) AS total_days
          FROM tos_daily_volume
          WHERE trade_date >= ($1::date - $2 * INTERVAL '1 day')
            AND trade_date < $1::date
        ),
        hist AS (
            SELECT symbol,
                   AVG(daily_volume) AS avg_vol
            FROM hist_ranked
            WHERE total_days >= 1
              AND pct_rank >= 0.1 AND pct_rank <= 0.9
            GROUP BY symbol
          ),
        today_vol AS (
          SELECT symbol, daily_volume AS cum_vol
          FROM tos_daily_volume
          WHERE trade_date = $1::date
        )
        SELECT t.symbol,
               t.cum_vol,
               ROUND(h.avg_vol, 2) as avg_daily_vol,
               (t.cum_vol / NULLIF(h.avg_vol, 0)) AS volume_ratio
        FROM today_vol t
        JOIN hist h USING (symbol)
        WHERE h.avg_vol > 0
          AND (t.cum_vol / NULLIF(h.avg_vol, 0)) < $3::numeric
        LIMIT 5;
      `;
      
      const res = await pool.query(sql, [targetDate, VOLUME_HISTORY_DAYS, cp.expected_pct]);
      console.log(`Found ${res.rowCount} potential alerts for ${cp.label}:`);
      res.rows.forEach(row => {
        console.log(`  ${row.symbol}: Ratio=${Number(row.volume_ratio).toFixed(4)} (Vol=${row.cum_vol}, Avg=${row.avg_daily_vol})`);
      });
    }

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

// Run test for '2026-03-09' (assuming today is Monday and we have data)
// If '2026-03-09' has no data, we might need to use '2026-03-08' but adjust logic.
// However, the user's log says "Weekend... skipping scan", implying it thinks today is Sunday (US time).
// If the user is in CN (Mon AM), then US is Sun PM.
// The latest trade date is '2026-03-08T16:00:00.000Z' which is Sunday 4PM in UTC (or Monday 00:00 in CN?).
// Wait, if trade_date is date type, '2026-03-08' means Sunday? Or Monday?
// Usually trade_date is local market date. If US market, it's Mon-Fri.
// 2026-03-08 is Sunday. 2026-03-09 is Monday.
// If latest date is 2026-03-08, maybe it's capturing Sunday trading? Or just the date conversion.
// Let's use '2026-03-09' and see if we get anything. If not, try '2026-03-06' (Friday).

testScan('2026-03-09');
