const http = require('http');

// 配置
const PORT = 8889;
const INTERVAL_MS = 5 * 60 * 1000; // 5分钟

function triggerRefresh() {
  const today = new Date().toISOString().split('T')[0];
  const options = {
    hostname: 'localhost',
    port: PORT,
    path: `/api/volume/daily-refresh?start=${today}&end=${today}`,
    method: 'POST'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`[${new Date().toISOString()}] Refresh ${today} - Status: ${res.statusCode}`);
    });
  });

  req.on('error', (e) => {
    console.error(`[${new Date().toISOString()}] Request failed: ${e.message}`);
  });

  req.end();
}

console.log(`[Cron Job] Starting daily volume refresh scheduler (Every ${INTERVAL_MS/1000}s)...`);

// 立即执行一次
triggerRefresh();

// 定时执行
setInterval(triggerRefresh, INTERVAL_MS);
