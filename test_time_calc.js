// Test script to verify Beijing time calculation logic
const MARKET_OPEN_MINS = 8 * 60; // 08:00 Beijing Time

function checkTime() {
    const now = new Date();
    const nowBeijing = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    
    const day = nowBeijing.getDay();
    const currentMins = nowBeijing.getHours() * 60 + nowBeijing.getMinutes();
    const elapsedMinutes = currentMins - MARKET_OPEN_MINS; 

    console.log('--- Time Check ---');
    console.log(`Local Time: ${now.toString()}`);
    console.log(`Beijing Time: ${nowBeijing.toLocaleString()}`);
    console.log(`Day of Week (0=Sun, 6=Sat): ${day}`);
    console.log(`Current Minutes (from 00:00): ${currentMins}`);
    console.log(`Market Open Minutes: ${MARKET_OPEN_MINS}`);
    console.log(`Elapsed Minutes: ${elapsedMinutes}`);
    
    if (elapsedMinutes <= 0) {
        console.log('Status: PRE-MARKET (Wait)');
    } else if (elapsedMinutes > 480) { // 8 hours * 60
        console.log('Status: POST-MARKET (Closed)');
    } else {
        console.log('Status: MARKET OPEN');
    }
}

checkTime();
