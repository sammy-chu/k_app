const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '192.168.31.247',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'ppro8_market_data',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
});

// Constants from server.js
const VOLUME_RATIO_THRESHOLD = 1.5;
const VOLUME_HISTORY_DAYS = 20;
const VOLUME_Z_THRESHOLD = 2;
const MIN_ELAPSED_PCT = 0.02; 

async function debugLogic() {
  try {
    await pool.query('SET search_path TO market_data');

    const today = new Date().toISOString().split('T')[0];
    const elapsedPct = 1.0; // Simulate end of day

    console.log(`Debugging for date: ${today}, elapsedPct: ${elapsedPct}`);

    // 1. Check hist_ranked count
    const sql1 = `
      SELECT COUNT(*) 
      FROM tos_daily_volume
      WHERE trade_date >= ($1::date - $2::int * INTERVAL '1 day')
        AND trade_date < $1::date
    `;
    const res1 = await pool.query(sql1, [today, VOLUME_HISTORY_DAYS]);
    console.log(`[Step 1] Rows in hist_ranked range: ${res1.rows[0].count}`);

    // 2. Check hist count (valid symbols with enough history)
    const sql2 = `
      WITH hist_ranked AS (
        SELECT symbol,
               daily_volume,
               PERCENT_RANK() OVER (PARTITION BY symbol ORDER BY daily_volume) AS pct_rank,
               COUNT(*) OVER (PARTITION BY symbol) AS total_days
        FROM tos_daily_volume
        WHERE trade_date >= ($1::date - $2::int * INTERVAL '1 day')
          AND trade_date < $1::date
      )
      SELECT COUNT(*) FROM (
        SELECT symbol
        FROM hist_ranked
        WHERE total_days >= 5
          AND pct_rank >= 0.1 AND pct_rank <= 0.9
        GROUP BY symbol
      ) t
    `;
    const res2 = await pool.query(sql2, [today, VOLUME_HISTORY_DAYS]);
    console.log(`[Step 2] Symbols with valid history (>= 5 days): ${res2.rows[0].count}`);

    // 3. Check today_vol count
    const sql3 = `
      SELECT COUNT(*)
      FROM tos_daily_volume
      WHERE trade_date = $1::date
    `;
    const res3 = await pool.query(sql3, [today]);
    console.log(`[Step 3] Symbols with volume today: ${res3.rows[0].count}`);

    // 4. Check join and condition
    const sql4 = `
      WITH hist_ranked AS (
        SELECT symbol,
               daily_volume,
               PERCENT_RANK() OVER (PARTITION BY symbol ORDER BY daily_volume) AS pct_rank,
               COUNT(*) OVER (PARTITION BY symbol) AS total_days
        FROM tos_daily_volume
        WHERE trade_date >= ($1::date - $3::int * INTERVAL '1 day')
          AND trade_date < $1::date
      ),
      hist AS (
        SELECT symbol,
               AVG(daily_volume) AS avg_vol,
               COALESCE(STDDEV(daily_volume), 0) AS std_vol
        FROM hist_ranked
        WHERE total_days >= 5
          AND pct_rank >= 0.1 AND pct_rank <= 0.9
        GROUP BY symbol
      ),
      today_vol AS (
        SELECT symbol, daily_volume AS cum_vol
        FROM tos_daily_volume
        WHERE trade_date = $1::date
      )
      SELECT t.symbol, t.cum_vol, h.avg_vol, h.std_vol, 
             (t.cum_vol / NULLIF(h.avg_vol * $4, 0)) as ratio,
             (t.cum_vol / $4 - h.avg_vol) / NULLIF(h.std_vol, 0) as z_score
      FROM today_vol t
      JOIN hist h USING (symbol)
      WHERE h.avg_vol > 0
    `;
    // Note: Parameter order matches server.js usage somewhat but adapted for this query
    // server.js: [today, VOLUME_RATIO_THRESHOLD, VOLUME_HISTORY_DAYS, elapsedPct, VOLUME_Z_THRESHOLD]
    // Here: $1=today, $2=ratio(unused), $3=days, $4=elapsed, $5=z(unused)
    
    const res4 = await pool.query(sql4, [today, VOLUME_RATIO_THRESHOLD, VOLUME_HISTORY_DAYS, elapsedPct, VOLUME_Z_THRESHOLD]);
    console.log(`[Step 4] Joined rows (before filtering): ${res4.rows.length}`);
    
    if (res4.rows.length > 0) {
        console.table(res4.rows.slice(0, 5)); // Show first 5
        
        // Filter manually to see why they fail
        const passing = res4.rows.filter(r => {
            const ratio = parseFloat(r.ratio);
            const z = parseFloat(r.z_score);
            return ratio >= VOLUME_RATIO_THRESHOLD || z >= VOLUME_Z_THRESHOLD;
        });
        console.log(`[Step 5] Rows passing threshold (${VOLUME_RATIO_THRESHOLD}x or Z>=${VOLUME_Z_THRESHOLD}): ${passing.length}`);
        if (passing.length > 0) {
            console.table(passing.slice(0, 5));
        }
    }

  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

debugLogic();
