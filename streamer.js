const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder'); 
const { spawn } = require('child_process');
const http = require('http');
const axios = require('axios');
const { URL } = require('url');
const fs = require('fs'); 
const path = require('path'); 

// 🎥 Video save karne ke liye folder setup
const videoDir = path.join(__dirname, 'videos');
if (!fs.existsSync(videoDir)){
    fs.mkdirSync(videoDir);
}

// ==========================================
// ⚙️ SETTINGS & COUNTERS
// ==========================================
const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
const STREAM_ID = process.env.STREAM_ID || '1'; 

// 🛡️ SMART PROXY SETTINGS
const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
const PROXY_SELECT = process.env.PROXY_SELECT || 'Proxy 1';

// 🌐 MULTI-PROXY LIST (Aap yahan naye proxies add kar sakte hain)
const PROXY_LIST = {
    'Proxy 1': { ip: '31.59.20.176', port: '6754', user: 'dgmtstlf', pass: 'pm4wnuro0gy9' },
    'Proxy 2': { ip: '31.58.9.4', port: '6077', user: 'dgmtstlf', pass: 'pm4wnuro0gy9' },
    'Proxy 3': { ip: '123.45.67.89', port: '8080', user: 'username3', pass: 'password3' } // Yeh ek example hai
};

const activeProxy = PROXY_LIST[PROXY_SELECT] || PROXY_LIST['Proxy 1'];

const PROXY_IP = activeProxy.ip;
const PROXY_PORT = activeProxy.port;
const PROXY_USER = activeProxy.user;
const PROXY_PASS = activeProxy.pass;

const MULTI_KEYS = {
    '1': '14601603391083_14040893622891_puxzrwjniu',
    '2': '14601696583275_14041072274027_apdzpdb5xi',
    '3': '14617940008555_14072500914795_ohw67ls7ny',
    '4': '14601972227691_14041593547371_obdhgewlmq'
};

const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// 🛡️ CRITICAL LOGIC COUNTERS
let consecutiveLinkFails = 0;
let consecutiveFfmpegFails = 0;
let currentFfmpeg = null;
let currentStream = null; 
let fetchCycle = 1;

function formatPKT(timestampMs) {
    return new Date(timestampMs).toLocaleString('en-US', {
        timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
        day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) + " PKT";
}

// ==========================================
// 💓 HEARTBEAT ENGINE (KEEPS GITHUB ALIVE)
// ==========================================
setInterval(() => {
    if (currentStream) {
        let remainingMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000);
        let minsLeft = Math.max(0, Math.round(remainingMs / 60000));
        console.log(`[💓 HEARTBEAT] Bot zinda hai aur stream chala raha hai! Next fetch in approx ${minsLeft} minutes...`);
    }
}, 5 * 60 * 1000); 

// ==========================================
// 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// ==========================================
const startLocalProxy = () => {
    const server = http.createServer(async (req, res) => {
        if (!currentStream) {
            res.writeHead(503); return res.end('Not Ready');
        }

        try {
            let targetUrl = currentStream.url;
            if (req.url.startsWith('/proxy?target=')) {
                targetUrl = decodeURIComponent(req.url.split('target=')[1]);
            } else if (req.url !== '/live.m3u8') {
                res.writeHead(404); return res.end();
            }

            if (targetUrl.includes('.m3u8')) {
                const response = await axios.get(targetUrl, {
                    responseType: 'text',
                    timeout: 15000, 
                    headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
                });

                const baseUrl = new URL(targetUrl);
                const rewritten = response.data.split('\n').map(line => {
                    let tLine = line.trim();
                    if (tLine === '') return line;
                    if (tLine.startsWith('#')) {
                        return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
                            let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
                            return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
                        });
                    }
                    let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
                    return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
                }).join('\n');

                res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
                res.end(rewritten);
                
            } else {
                const response = await axios.get(targetUrl, {
                    responseType: 'stream',
                    timeout: 15000, 
                    headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
                });
                res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
                response.data.pipe(res);
            }
        } catch (err) {
            res.writeHead(500); res.end();
        }
    });

    server.listen(8080, () => {
        console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
    });
};

// ==========================================
// 1️⃣ LINK EXTRACTION (PUPPETEER)
// ==========================================
async function getStreamData(isBackgroundFetch = false) {
    let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
    console.log(`\n${"-".repeat(60)}`);
    console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
    console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
    console.log(`${"-".repeat(60)}`);
    
    let browserArgs = [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-blink-features=AutomationControlled', 
        '--mute-audio',
        '--autoplay-policy=no-user-gesture-required' 
    ];
    
    let useProxyForThisRun = false;
    if (USE_PROXY === 'Yes (Proxy ON)') {
        useProxyForThisRun = true;
    } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
        useProxyForThisRun = true;
    }

    if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
        browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
        console.log(`  [🛡️] Proxy Mode: ON (${PROXY_SELECT} -> ${PROXY_IP})`);
    } else {
        console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
    }

    const browser = await puppeteer.launch({ 
        headless: true, 
        defaultViewport: { width: 1280, height: 720 }, 
        args: browserArgs 
    });
    const page = await browser.newPage();

    if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
        await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
    }

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const recorder = new PuppeteerScreenRecorder(page);
    const videoFileName = `stream-video-cycle${fetchCycle}-${Date.now()}.mp4`;
    const videoPath = path.join(videoDir, videoFileName);
    
    console.log(`🎥 Video recording start kar raha hoon...`);
    await recorder.start(videoPath);

    let streamData = null;

    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('.m3u8')) {
            const urlObj = new URL(url);
            const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
            streamData = {
                url: url,
                ua: request.headers()['user-agent'] || '', 
                referer: request.headers()['referer'] || TARGET_URL,
                cookie: request.headers()['cookie'] || '',
                expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
            };
        }
    });

    try {
        console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.click('body').catch(() => {});
        console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
        for (let i = 1; i <= 3; i++) {
            await new Promise(r => setTimeout(r, 5000));
            if (streamData) break;
        }
    } catch (e) {
        if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
    }
    
    console.log("🛑 Video recording stop kar raha hoon...");
    await recorder.stop();

    await browser.close();

    if (streamData) {
        consecutiveLinkFails = 0; 
        console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
        console.log(`  🔗 [M3U8 LINK]: ${streamData.url.substring(0, 80)}...`); 
        console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
        return streamData;
    } else {
        if (!isBackgroundFetch) {
            consecutiveLinkFails++;
            console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
            if (consecutiveLinkFails >= 3) {
                console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
                process.exit(1); 
            }
        }
        return null;
    }
}

// ==========================================
// 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// ==========================================
function startFfmpeg() {
    console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
    console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
    const args = [
        "-re", "-loglevel", "error", 
        "-i", "http://127.0.0.1:8080/live.m3u8", 
        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
        "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
        "-f", "flv", RTMP_URL
    ];

    const ffmpeg = spawn('ffmpeg', args);
    const startTime = Date.now();
    let hasOkRuError = false; 

    ffmpeg.stderr.on('data', (err) => {
        const msg = err.toString();
        if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
            console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
            hasOkRuError = true; 
        }
    });

    ffmpeg.on('close', (code) => {
        const duration = (Date.now() - startTime) / 1000;
        console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

        if (hasOkRuError || (code !== 0 && duration < 120)) {
            consecutiveFfmpegFails++;
            console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
            if (consecutiveFfmpegFails >= 3) {
                console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
                process.exit(1);
            }
        } else if (duration >= 120) {
            consecutiveFfmpegFails = 0; 
        }

        console.log(`[🔄] Auto-Restarting FFmpeg...`);
        currentFfmpeg = startFfmpeg();
    });

    return ffmpeg;
}

// ==========================================
// 🚀 MAIN MANAGER LOOP & ALARM
// ==========================================
async function scheduleNextFetch() {
    
    let waitTimeMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000); 
    if (waitTimeMs < 0) waitTimeMs = 3000;

    console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/1000)} seconds.`);
    console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

    setTimeout(async () => {
        console.log(`\n${"=".repeat(60)}`);
        console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
        console.log(`${"=".repeat(60)}`);
        
        fetchCycle++; 
        let newData = await getStreamData(true);
        
        if (newData) {
            currentStream = newData; 
            console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
            console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
        } else {
            console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, 3 seconds baad dobara try karunga.`);
        }

        scheduleNextFetch(); 
    }, waitTimeMs);
}

async function mainLoop() {
    console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
    startLocalProxy();

    currentStream = await getStreamData();
    if (!currentStream) {
        console.log(`[🔄] 3 seconds baad retry...`);
        setTimeout(mainLoop, 3000);
        return;
    }

    currentFfmpeg = startFfmpeg();

    scheduleNextFetch();
}

mainLoop();








// # ============ done ahhah ======================



// const puppeteer = require('puppeteer');
// const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder'); // 🎥 ADDED
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');
// const fs = require('fs'); // 🎥 ADDED
// const path = require('path'); // 🎥 ADDED

// // 🎥 Video save karne ke liye folder setup
// const videoDir = path.join(__dirname, 'videos');
// if (!fs.existsSync(videoDir)){
//     fs.mkdirSync(videoDir);
// }

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ SMART PROXY SETTINGS
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 💓 HEARTBEAT ENGINE (KEEPS GITHUB ALIVE)
// // ==========================================
// setInterval(() => {
//     if (currentStream) {
//         let remainingMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000);
//         let minsLeft = Math.max(0, Math.round(remainingMs / 60000));
//         console.log(`[💓 HEARTBEAT] Bot zinda hai aur stream chala raha hai! Next fetch in approx ${minsLeft} minutes...`);
//     }
// }, 5 * 60 * 1000); // Har 5 minute baad print hoga taake GitHub soye nahi!

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     timeout: 15000, // Anti-Hang Timeout
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     timeout: 15000, // Anti-Hang Timeout
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
//                 response.data.pipe(res);
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     // 🎥 ADDED: '--autoplay-policy=no-user-gesture-required' flag
//     let browserArgs = [
//         '--no-sandbox', 
//         '--disable-setuid-sandbox', 
//         '--disable-blink-features=AutomationControlled', 
//         '--mute-audio',
//         '--autoplay-policy=no-user-gesture-required' 
//     ];
    
//     // 🛡️ SMART PROXY LOGIC
//     let useProxyForThisRun = false;
//     if (USE_PROXY === 'Yes (Proxy ON)') {
//         useProxyForThisRun = true;
//     } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
//         useProxyForThisRun = true;
//     }

//     if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     // 🎥 ADDED: defaultViewport HD set kiya video ke liye
//     const browser = await puppeteer.launch({ 
//         headless: true, 
//         defaultViewport: { width: 1280, height: 720 }, 
//         args: browserArgs 
//     });
//     const page = await browser.newPage();

//     if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     // 🎥 ADDED: Video Recorder initialization
//     const recorder = new PuppeteerScreenRecorder(page);
//     const videoFileName = `stream-video-cycle${fetchCycle}-${Date.now()}.mp4`;
//     const videoPath = path.join(videoDir, videoFileName);
    
//     console.log(`🎥 Video recording start kar raha hoon...`);
//     await recorder.start(videoPath);

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         // 🌟 FIX: Changed networkidle2 to domcontentloaded for faster & safer load
//         await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
//         for (let i = 1; i <= 3; i++) {
//             await new Promise(r => setTimeout(r, 5000));
//             if (streamData) break;
//         }
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     // 🎥 ADDED: Stop Recording
//     console.log("🛑 Video recording stop kar raha hoon...");
//     await recorder.stop();

//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url.substring(0, 80)}...`); // Shortened to keep logs clean
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
    
//     // ⚠️ ASLI LOGIC: Expire hone se exactly 5 Minute (5 * 60 * 1000) pehle!
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; // Agla chakar shuru
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         // Agle chakar ka alarm dobara set karo
//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();

//     // Alarm lagao agle link ke liye
//     scheduleNextFetch();
// }

// mainLoop();
















// ========== below error few code i write 1000 below with code start se correct  =======================




// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');

// // ==========================================
// // 🛡️ ANTI-CRASH SHIELDS (PREVENTS SILENT FREEZE)
// // ==========================================
// process.on('uncaughtException', (err) => {
//     console.log(`\n[🛡️ SILENT CRASH PREVENTED] Exception: ${err.message}`);
// });
// process.on('unhandledRejection', (reason) => {
//     console.log(`\n[🛡️ SILENT CRASH PREVENTED] Rejection: ${reason}`);
// });

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ SMART PROXY SETTINGS
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1;
// let isProxyRunning = false; // 🌟 NAYA LOCK: Proxy collision prevent karne ke liye

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 💓 HEARTBEAT ENGINE (KEEPS GITHUB ALIVE)
// // ==========================================
// setInterval(() => {
//     if (currentStream) {
//         let remainingMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000);
//         let minsLeft = Math.max(0, Math.round(remainingMs / 60000));
//         console.log(`[💓 HEARTBEAT] Bot zinda hai aur stream chala raha hai! Next fetch in approx ${minsLeft} minutes...`);
//     }
// }, 5 * 60 * 1000); 

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     if (isProxyRunning) return; // 🌟 LOCK: Agar proxy chal rahi hai toh wapas mud jao!

//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     timeout: 15000, 
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     timeout: 15000, 
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
                
//                 response.data.pipe(res);
//                 response.data.on('error', () => {});
//                 res.on('error', () => {});
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         isProxyRunning = true;
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     // 🌟 FIX: Added autoplay unblocker to force video to start
//     let browserArgs = [
//         '--no-sandbox', 
//         '--disable-setuid-sandbox', 
//         '--disable-blink-features=AutomationControlled', 
//         '--mute-audio',
//         '--autoplay-policy=no-user-gesture-required' 
//     ];
    
//     let useProxyForThisRun = false;
//     if (USE_PROXY === 'Yes (Proxy ON)') {
//         useProxyForThisRun = true;
//     } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
//         useProxyForThisRun = true;
//     }

//     if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        
//         // Extra push to click the play button if needed
//         await page.click('body').catch(() => {});
        
//         console.log(`  [⏳ JS] Smart Wait: M3U8 link ka intezar kar raha hoon (Max 45 sec)...`);
        
//         // 🌟 FIX: SMART WAIT LOOP
//         let waitTimer = 0;
//         while (!streamData && waitTimer < 45) {
//             await new Promise(r => setTimeout(r, 1000));
//             waitTimer++;
//         }

//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url.substring(0, 80)}...`); 
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (THE DHEET ENGINE)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
        
//         // 🛡️ THE DHEET FLAGS
//         "-reconnect", "1", 
//         "-reconnect_at_eof", "1", 
//         "-reconnect_streamed", "1", 
//         "-reconnect_delay_max", "5", 
//         "-fflags", "+genpts+igndts",
//         "-err_detect", "ignore_err",
        
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (70 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; 
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();
//     scheduleNextFetch();
// }

// mainLoop();




















// const puppeteer = require('puppeteer');
// const { spawnSync, execSync, spawn } = require('child_process');
// const fs = require('fs');
// const FormData = require('form-data');
// const axios = require('axios'); 
// const http = require('http');
// const { URL } = require('url');

// // ==========================================
// // 🛡️ ANTI-CRASH SHIELDS (PREVENTS SILENT FREEZE)
// // ==========================================
// process.on('uncaughtException', (err) => {
//     console.log(`\n[🛡️ SILENT CRASH PREVENTED] Exception: ${err.message}`);
// });
// process.on('unhandledRejection', (reason) => {
//     console.log(`\n[🛡️ SILENT CRASH PREVENTED] Rejection: ${reason}`);
// });

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ SMART PROXY SETTINGS
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 💓 HEARTBEAT ENGINE (KEEPS GITHUB ALIVE)
// // ==========================================
// setInterval(() => {
//     if (currentStream) {
//         let remainingMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000);
//         let minsLeft = Math.max(0, Math.round(remainingMs / 60000));
//         console.log(`[💓 HEARTBEAT] Bot zinda hai aur stream chala raha hai! Next fetch in approx ${minsLeft} minutes...`);
//     }
// }, 5 * 60 * 1000); 

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     timeout: 15000, 
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     timeout: 15000, 
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
                
//                 // 🌟 FIX: Prevent Pipe Hangs
//                 response.data.pipe(res);
//                 response.data.on('error', () => { /* Ignore background network drops */ });
//                 res.on('error', () => { /* Ignore broken pipes */ });
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     let useProxyForThisRun = false;
//     if (USE_PROXY === 'Yes (Proxy ON)') {
//         useProxyForThisRun = true;
//     } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
//         useProxyForThisRun = true;
//     }

//     if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         // 🌟 FIX: domcontentloaded makes it fast and safe from freezing
//         await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
//         for (let i = 1; i <= 3; i++) {
//             await new Promise(r => setTimeout(r, 5000));
//             if (streamData) break;
//         }
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url.substring(0, 80)}...`); 
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (THE DHEET ENGINE)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
        
//         // 🛡️ NAYE DHEET (STUBBORN) FLAGS: FFmpeg ko proxy drop/swap par band hone se rokenge!
//         "-reconnect", "1", 
//         "-reconnect_at_eof", "1", 
//         "-reconnect_streamed", "1", 
//         "-reconnect_delay_max", "5", 
        
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (70 * 60 * 1000); // haha
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; 
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();
//     scheduleNextFetch();
// }

// mainLoop();





















// 1000

// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ SMART PROXY SETTINGS
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 💓 HEARTBEAT ENGINE (KEEPS GITHUB ALIVE)
// // ==========================================
// setInterval(() => {
//     if (currentStream) {
//         let remainingMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000);
//         let minsLeft = Math.max(0, Math.round(remainingMs / 60000));
//         console.log(`[💓 HEARTBEAT] Bot zinda hai aur stream chala raha hai! Next fetch in approx ${minsLeft} minutes...`);
//     }
// }, 5 * 60 * 1000); // Har 5 minute baad print hoga taake GitHub soye nahi!

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     timeout: 15000, // Anti-Hang Timeout
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     timeout: 15000, // Anti-Hang Timeout
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
//                 response.data.pipe(res);
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     // 🛡️ SMART PROXY LOGIC
//     let useProxyForThisRun = false;
//     if (USE_PROXY === 'Yes (Proxy ON)') {
//         useProxyForThisRun = true;
//     } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
//         useProxyForThisRun = true;
//     }

//     if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         // 🌟 FIX: Changed networkidle2 to domcontentloaded for faster & safer load
//         await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
//         for (let i = 1; i <= 3; i++) {
//             await new Promise(r => setTimeout(r, 5000));
//             if (streamData) break;
//         }
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url.substring(0, 80)}...`); // Shortened to keep logs clean
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
    
//     // ⚠️ ASLI LOGIC: Expire hone se exactly 5 Minute (5 * 60 * 1000) pehle!
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; // Agla chakar shuru
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         // Agle chakar ka alarm dobara set karo
//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();

//     // Alarm lagao agle link ke liye
//     scheduleNextFetch();
// }

// mainLoop();





















// ============== iss mei eek issse hai k server sleep mei chal jata hai ========*&&**********


// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ SMART PROXY SETTINGS
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
//                 response.data.pipe(res);
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     // 🛡️ SMART PROXY LOGIC
//     let useProxyForThisRun = false;
//     if (USE_PROXY === 'Yes (Proxy ON)') {
//         useProxyForThisRun = true;
//     } else if (USE_PROXY === 'Only First Time (Proxy FIRST)' && !isBackgroundFetch) {
//         useProxyForThisRun = true;
//     }

//     if (useProxyForThisRun && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     // Authenticate Proxy if needed
//     if (useProxyForThisRun && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
//         await new Promise(r => setTimeout(r, 15000));
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url}`);
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
    
//     // ⚠️ ASLI LOGIC: Expire hone se exactly 5 Minute (5 * 60 * 1000) pehle!
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (5 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; // Agla chakar shuru
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         // Agle chakar ka alarm dobara set karo
//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();

//     // Alarm lagao agle link ke liye
//     scheduleNextFetch();
// }

// mainLoop();



























// ==================== done , ooper waley mei onr time proxy system add kya hai =======================



// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ PROXY SETTINGS & SWITCH
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
// const IS_PROXY_ON = USE_PROXY === 'Yes (Proxy ON)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; 
// let fetchCycle = 1; // 🌟 NAYA: Cycle counter add kiya gaya hai

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
//                 response.data.pipe(res);
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`\n[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     let modeText = isBackgroundFetch ? "BACKGROUND SWAP MODE" : "FIRST BOOT MODE";
//     console.log(`\n${"-".repeat(60)}`);
//     console.log(`[🔍 CYCLE #${fetchCycle}] Puppeteer Chrome Start kar raha hoon... (${modeText})`);
//     console.log(`[⏰ TIME] Fetch started at: ${formatPKT(Date.now())}`);
//     console.log(`${"-".repeat(60)}`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     if (IS_PROXY_ON && PROXY_IP && PROXY_PORT) browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     if (IS_PROXY_ON && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', 
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         console.log(`  [🌐 JS] Going to Target URL: ${TARGET_URL}`);
//         await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         console.log(`  [⏳ JS] Waiting 15 seconds to grab the M3U8 link...`);
//         await new Promise(r => setTimeout(r, 15000));
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`  [❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n  🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`  🔗 [M3U8 LINK]: ${streamData.url}`);
//         console.log(`  📅 [TOTAL ORIGINAL EXPIRY]: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n  🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n  🛑 [FATAL] 3 baar consecutive link nahi mila. Bot stopped.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// // ==========================================
// function startFfmpeg() {
//     console.log(`\n[🚀 STEP 2] FFmpeg Engine Shuru... (Internal Proxy par connected)`);
//     console.log(`[⏰ TIME] FFmpeg Started at: ${formatPKT(Date.now())}`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
//         "-i", "http://127.0.0.1:8080/live.m3u8", 
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
    
//     // 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨
//     // ⚠️ TESTING MODE: 2 MINUTE SWAP LOGIC
//     // ----------------------------------------------------------------
//     // Asli Logic (Commented Out):
//     // let waitTimeMs = (currentStream.expireTime - Date.now()) - (4 * 60 * 1000); 
//     // if (waitTimeMs < 0) waitTimeMs = 60000;
//     // ----------------------------------------------------------------
    
//     // Testing ke liye fix 2 minute (120,000 milliseconds) ka timer
//     let waitTimeMs = 2 * 60 * 1000; 
    
//     // Jab testing khatam ho jaye toh is 2 min wali line ko delete kar dena, 
//     // aur upar wali "Asli Logic" ko uncomment kar dena!
//     // 🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨🚨

//     console.log(`\n[⏳ ALARM SET] Next Background Fetch will trigger exactly in ${Math.round(waitTimeMs/60000)} minutes.`);
//     console.log(`[⏰ TRIGGER TIME] Alarm baje ga: ${formatPKT(Date.now() + waitTimeMs)}`);

//     setTimeout(async () => {
//         console.log(`\n${"=".repeat(60)}`);
//         console.log(`⏰ [ALARM RINGS!] Purani stream chal rahi hai... Background mein naya link lene ja raha hoon.`);
//         console.log(`${"=".repeat(60)}`);
        
//         fetchCycle++; // Agla chakar shuru
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; 
//             console.log(`\n💥 [MAGIC SWAP!] Naya link internally Local Proxy ko de diya gaya hai!`);
//             console.log(`💥 [0% DOWNTIME] FFmpeg ko jhatka bhi nahi laga aur stream naye link par transfer ho gayi!`);
//         } else {
//             console.log(`\n⚠️ [SWAP FAILED] Background fetch fail hua, aglay minute dobara try karunga.`);
//         }

//         // Agle chakar ka alarm dobara set karo
//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[🚀 MAIN] System Boot: ${formatPKT(Date.now())}`);
    
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg();

//     // Alarm lagao agle link ke liye
//     scheduleNextFetch();
// }

// mainLoop();





// ======== ooper testing ==================

// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const http = require('http');
// const axios = require('axios');
// const { URL } = require('url');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ PROXY SETTINGS & SWITCH
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
// const IS_PROXY_ON = USE_PROXY === 'Yes (Proxy ON)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;
// let currentFfmpeg = null;
// let currentStream = null; // 🌟 INTERNAL PROXY KE LIYE DATA

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 🌐 THE MAGIC: LOCAL HLS PROXY SERVER (0% DOWNTIME)
// // ==========================================
// const startLocalProxy = () => {
//     const server = http.createServer(async (req, res) => {
//         if (!currentStream) {
//             res.writeHead(503); return res.end('Not Ready');
//         }

//         try {
//             let targetUrl = currentStream.url;
//             if (req.url.startsWith('/proxy?target=')) {
//                 targetUrl = decodeURIComponent(req.url.split('target=')[1]);
//             } else if (req.url !== '/live.m3u8') {
//                 res.writeHead(404); return res.end();
//             }

//             // Agar m3u8 playlist hai toh URL rewrite karni paregi
//             if (targetUrl.includes('.m3u8')) {
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'text',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });

//                 const baseUrl = new URL(targetUrl);
//                 const rewritten = response.data.split('\n').map(line => {
//                     let tLine = line.trim();
//                     if (tLine === '') return line;
                    
//                     // URI Keys Rewrite
//                     if (tLine.startsWith('#')) {
//                         return tLine.replace(/URI="(.*?)"/g, (match, p1) => {
//                             let absUrl = p1.startsWith('http') ? p1 : new URL(p1, baseUrl).toString();
//                             return `URI="http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absUrl)}"`;
//                         });
//                     }

//                     // Video Chunks (TS) Rewrite
//                     let absoluteUrl = tLine.startsWith('http') ? tLine : new URL(tLine, baseUrl).toString();
//                     return `http://127.0.0.1:8080/proxy?target=${encodeURIComponent(absoluteUrl)}`;
//                 }).join('\n');

//                 res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
//                 res.end(rewritten);
                
//             } else {
//                 // Video Chunk (.ts) direct FFmpeg ko stream kar do
//                 const response = await axios.get(targetUrl, {
//                     responseType: 'stream',
//                     headers: { 'User-Agent': currentStream.ua, 'Referer': currentStream.referer, 'Cookie': currentStream.cookie }
//                 });
//                 res.writeHead(200, { 'Content-Type': response.headers['content-type'] || 'video/MP2T' });
//                 response.data.pipe(res);
//             }
//         } catch (err) {
//             res.writeHead(500); res.end();
//         }
//     });

//     server.listen(8080, () => {
//         console.log(`[🌐 PROXY] Local HLS Server Started at http://127.0.0.1:8080`);
//     });
// };

// // ==========================================
// // 1️⃣ LINK EXTRACTION (PUPPETEER)
// // ==========================================
// async function getStreamData(isBackgroundFetch = false) {
//     if (!isBackgroundFetch) console.log(`\n[🔍 STEP 1] Puppeteer Chrome Start... (Koshish #${consecutiveLinkFails + 1})`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     if (IS_PROXY_ON && PROXY_IP && PROXY_PORT) browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);

//     const browser = await puppeteer.launch({ headless: true, args: browserArgs });
//     const page = await browser.newPage();

//     if (IS_PROXY_ON && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             streamData = {
//                 url: url,
//                 ua: request.headers()['user-agent'] || '', // 🌟 Yahan User-Agent zaroori tha
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000)
//             };
//         }
//     });

//     try {
//         await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         await new Promise(r => setTimeout(r, 15000));
//     } catch (e) {
//         if (!isBackgroundFetch) console.log(`[❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         return streamData;
//     } else {
//         if (!isBackgroundFetch) {
//             consecutiveLinkFails++;
//             console.log(`\n🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
//             if (consecutiveLinkFails >= 3) {
//                 console.log(`\n🛑 [FATAL] 3 baar consecutive link nahi mila. Bot ko safety ke liye stop kar raha hoon.`);
//                 process.exit(1); 
//             }
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (CONNECTS TO INTERNAL PROXY)
// // ==========================================
// function startFfmpeg() {
//     console.log(`[🚀 STEP 2] FFmpeg Shuru... (Internal Proxy par connected)`);
    
//     const args = [
//         "-re", "-loglevel", "error", 
//         "-i", "http://127.0.0.1:8080/live.m3u8", // 🌟 FFMPEG AB DIRECT WEBSITE PE NAHI JAYEGA
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         const duration = (Date.now() - startTime) / 1000;
//         console.log(`\n⚠️ FFmpeg Crash ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai. Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }

//         // Agar FFmpeg kisi bhi wajah se band ho, toh foran restart kardo
//         console.log(`[🔄] Auto-Restarting FFmpeg...`);
//         currentFfmpeg = startFfmpeg();
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP & ALARM
// // ==========================================
// async function scheduleNextFetch() {
//     // Expiry se exactly 4 minute pehle link fetch karna shuru karega
//     let waitTimeMs = (currentStream.expireTime - Date.now()) - (4 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`[⏳] 0% Downtime Alarm Set: ${Math.round(waitTimeMs/60000)} minutes baad background refresh hogi.`);

//     setTimeout(async () => {
//         console.log(`\n⏰ [BACKGROUND FETCH] Purani stream live chal rahi hai... Naya link fetch ho raha hai.`);
        
//         let newData = await getStreamData(true);
        
//         if (newData) {
//             currentStream = newData; // 🌟 MAGIC HAPPENS HERE: Proxy naya data read karna shuru kar degi
//             console.log(`[♻️ SEAMLESS SWAP] Link internally update ho gaya. FFmpeg ko pata bhi nahi chala! (0% Downtime)`);
//         } else {
//             console.log(`[⚠️] Background fetch fail hua, stream abhi chal rahi hai, aglay minute dobara try karunga.`);
//         }

//         // Loop cycle
//         scheduleNextFetch(); 
//     }, waitTimeMs);
// }

// async function mainLoop() {
//     console.log(`\n[⏰ MANAGER] System Boot: ${formatPKT(Date.now())}`);
    
//     // Start Local Proxy Server First
//     startLocalProxy();

//     currentStream = await getStreamData();
//     if (!currentStream) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     console.log(`\n🎉 [BINGO] Initial Link Found. Starting Seamless Stream!`);
//     currentFfmpeg = startFfmpeg();

//     scheduleNextFetch();
// }

// mainLoop();




























































// ================== 100% perfect, bas eek new update add karney k try kar rahey hai 0% (Seamless) with ok.ru , oopper code mei =========================


// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// // 🛡️ NAYA: PROXY SETTINGS & SWITCH
// const USE_PROXY = process.env.USE_PROXY || 'No (Proxy OFF)';
// const IS_PROXY_ON = USE_PROXY === 'Yes (Proxy ON)';

// const PROXY_IP = process.env.PROXY_IP || '';
// const PROXY_PORT = process.env.PROXY_PORT || '';
// const PROXY_USER = process.env.PROXY_USER || '';
// const PROXY_PASS = process.env.PROXY_PASS || '';

// const MULTI_KEYS = {
//     '1': '14601603391083_14040893622891_puxzrwjniu',
//     '2': '14601696583275_14041072274027_apdzpdb5xi',
//     '3': '14617940008555_14072500914795_ohw67ls7ny',
//     '4': '14601972227691_14041593547371_obdhgewlmq'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;

// let currentFfmpeg = null;
// const START_TIME = Date.now();
// const ACTION_LIMIT_MS = (5 * 60 * 60 + 45 * 60) * 1000;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 1️⃣ LINK EXTRACTION (WITH STRIKE LOGIC & PROXY)
// // ==========================================
// async function getStreamData() {
//     console.log(`\n[🔍 STEP 1] Puppeteer Chrome Start... (Koshish #${consecutiveLinkFails + 1})`);
    
//     let browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'];
    
//     // 🛡️ NAYA: Proxy Check Logic
//     if (IS_PROXY_ON && PROXY_IP && PROXY_PORT) {
//         browserArgs.push(`--proxy-server=http://${PROXY_IP}:${PROXY_PORT}`);
//         console.log(`  [🛡️] Proxy Mode: ON (${PROXY_IP})`);
//     } else {
//         console.log(`  [🚀] Proxy Mode: OFF (Direct Connection)`);
//     }

//     const browser = await puppeteer.launch({ 
//         headless: true, 
//         args: browserArgs 
//     });
    
//     const page = await browser.newPage();

//     // 🛡️ NAYA: Proxy Authentication
//     if (IS_PROXY_ON && PROXY_USER && PROXY_PASS) {
//         await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
//     }

//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             let expireMs = expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000);

//             streamData = {
//                 url: url,
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expireMs
//             };
//         }
//     });

//     try {
//         await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         await new Promise(r => setTimeout(r, 15000));
//     } catch (e) {
//         console.log(`[❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; 
//         console.log(`\n🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`⏰ EXPIRY: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         consecutiveLinkFails++;
//         console.log(`\n🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
        
//         if (consecutiveLinkFails >= 3) {
//             console.log(`\n🛑 [FATAL] 3 baar consecutive link nahi mila. Bot ko safety ke liye stop kar raha hoon.`);
//             process.exit(1); 
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (WITH SMART ERROR DETECTION)
// // ==========================================
// function startFfmpeg(data) {
//     console.log(`[🚀 STEP 2] FFmpeg Shuru... (Strike Counter: ${consecutiveFfmpegFails}/3)`);
    
//     const headersCmd = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nReferer: ${data.referer}\r\nCookie: ${data.cookie}\r\n`;
    
//     const args = [
//         "-re", "-loglevel", "error", "-headers", headersCmd, "-i", data.url,
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; 

//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; 
//         }
//     });

//     ffmpeg.on('close', (code, signal) => {
//         const duration = (Date.now() - startTime) / 1000;

//         if (signal === 'SIGKILL' || signal === 'SIGTERM') {
//             console.log(`[♻️ SWAP CLEANUP] Purana FFmpeg successfully swap ho gaya.`);
//             return; 
//         }

//         console.log(`\n⚠️ FFmpeg band ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
            
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai (3 Strikes). Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; 
//         }
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP
// // ==========================================
// async function mainLoop() {
//     console.log(`\n[⏰ MANAGER] Time: ${formatPKT(Date.now())}`);

//     let streamData = await getStreamData();
    
//     if (!streamData) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg(streamData);

//     let waitTimeMs = (streamData.expireTime - Date.now()) - (3 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`[⏳] Bot Alarm Set: ${formatPKT(Date.now() + waitTimeMs)} par naya link layega.`);

//     setTimeout(async () => {
//         console.log(`\n⏰ [ALARM] Naya link lene ka waqt ho gaya.`);
        
//         let newData = await getStreamData();
        
//         if (newData) {
//             console.log(`[⚡ SWAP] Naya FFmpeg chala kar purana SIGKILL kar raha hoon...`);
//             if (currentFfmpeg) {
//                 currentFfmpeg.kill('SIGKILL'); 
//             }
//             currentFfmpeg = startFfmpeg(newData);
//         }

//         mainLoop(); 
//     }, waitTimeMs);
// }

// // Script Start
// mainLoop();













// =========== yeh good 100% kaam kar raha hai bas isme proxy on and off wala feature add kya hai taaky kuch bey hu skta hai ============================



// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');

// // ==========================================
// // ⚙️ SETTINGS & COUNTERS
// // ==========================================
// const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
// const STREAM_ID = process.env.STREAM_ID || '1'; 

// const MULTI_KEYS = {
//     '1': '14136719122027_13152308497003_hnlk6em2e4',
//     '2': '14136743566955_13152356600427_vmdsemtmo4',
//     '3': '14136762048107_13152392710763_22fobqpsdi',
//     '4': '14136778563179_13152426265195_c5quhoj2vm'
// };

// const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// // 🛡️ CRITICAL LOGIC COUNTERS
// let consecutiveLinkFails = 0;
// let consecutiveFfmpegFails = 0;

// let currentFfmpeg = null;
// const START_TIME = Date.now();
// const ACTION_LIMIT_MS = (5 * 60 * 60 + 45 * 60) * 1000;

// function formatPKT(timestampMs) {
//     return new Date(timestampMs).toLocaleString('en-US', {
//         timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
//         day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
//     }) + " PKT";
// }

// // ==========================================
// // 1️⃣ LINK EXTRACTION (WITH STRIKE LOGIC)
// // ==========================================
// async function getStreamData() {
//     console.log(`\n[🔍 STEP 1] Puppeteer Chrome Start... (Koshish #${consecutiveLinkFails + 1})`);
    
//     const browser = await puppeteer.launch({ 
//         headless: true, 
//         args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'] 
//     });
    
//     const page = await browser.newPage();
//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
//             let expireMs = expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000);

//             streamData = {
//                 url: url,
//                 referer: request.headers()['referer'] || TARGET_URL,
//                 cookie: request.headers()['cookie'] || '',
//                 expireTime: expireMs
//             };
//         }
//     });

//     try {
//         await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
//         await page.click('body').catch(() => {});
//         await new Promise(r => setTimeout(r, 15000));
//     } catch (e) {
//         console.log(`[❌ ERROR] Page load nahi ho saka.`);
//     }
    
//     await browser.close();

//     if (streamData) {
//         consecutiveLinkFails = 0; // Success! Counter reset
//         console.log(`\n🎉 [BINGO] Link Extract Ho Gaya!`);
//         console.log(`⏰ EXPIRY: ${formatPKT(streamData.expireTime)}`);
//         return streamData;
//     } else {
//         consecutiveLinkFails++;
//         console.log(`\n🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
        
//         if (consecutiveLinkFails >= 3) {
//             console.log(`\n🛑 [FATAL] 3 baar consecutive link nahi mila. Bot ko safety ke liye stop kar raha hoon.`);
//             process.exit(1); 
//         }
//         return null;
//     }
// }

// // ==========================================
// // 2️⃣ FFMPEG (WITH SMART ERROR DETECTION)
// // ==========================================
// function startFfmpeg(data) {
//     console.log(`[🚀 STEP 2] FFmpeg Shuru... (Strike Counter: ${consecutiveFfmpegFails}/3)`);
    
//     const headersCmd = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nReferer: ${data.referer}\r\nCookie: ${data.cookie}\r\n`;
    
//     const args = [
//         "-re", "-loglevel", "error", "-headers", headersCmd, "-i", data.url,
//         "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
//         "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
//     const startTime = Date.now();
//     let hasOkRuError = false; // 🛡️ Naya flag OK.ru ke errors ke liye

//     // Error pakarne ka logic
//     ffmpeg.stderr.on('data', (err) => {
//         const msg = err.toString();
//         // Agar ok.ru block kare (403, 404, connection refused)
//         if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
//             console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
//             hasOkRuError = true; // Error detected
//         }
//     });

//     // Close event - Yahan faisla hoga ke strike deni hai ya nahi
//     ffmpeg.on('close', (code, signal) => {
//         const duration = (Date.now() - startTime) / 1000;

//         // 🛡️ NAYA LOGIC: Agar humne khud swap ke waqt SIGKILL bheja hai, toh strike nahi deni!
//         if (signal === 'SIGKILL' || signal === 'SIGTERM') {
//             console.log(`[♻️ SWAP CLEANUP] Purana FFmpeg successfully swap ho gaya.`);
//             return; 
//         }

//         console.log(`\n⚠️ FFmpeg band ho gaya. (Code: ${code}, Duration: ${duration}s)`);

//         // Strike sirf tab count hogi agar:
//         // 1. OK.ru ne error diya ho (hasOkRuError)
//         // 2. YA 2 minute chala hi na ho (Asli crash)
//         if (hasOkRuError || (code !== 0 && duration < 120)) {
//             consecutiveFfmpegFails++;
//             console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
            
//             if (consecutiveFfmpegFails >= 3) {
//                 console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai (3 Strikes). Workflow khtam.`);
//                 process.exit(1);
//             }
//         } else if (duration >= 120) {
//             consecutiveFfmpegFails = 0; // Agar 2 min chal gaya matlab sahi chal raha tha, toh reset.
//         }
//     });

//     return ffmpeg;
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP
// // ==========================================
// async function mainLoop() {
//     console.log(`\n[⏰ MANAGER] Time: ${formatPKT(Date.now())}`);

//     let streamData = await getStreamData();
    
//     if (!streamData) {
//         console.log(`[🔄] 1 minute baad retry...`);
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg(streamData);

//     let waitTimeMs = (streamData.expireTime - Date.now()) - (3 * 60 * 1000); 
//     if (waitTimeMs < 0) waitTimeMs = 60000;

//     console.log(`[⏳] Bot Alarm Set: ${formatPKT(Date.now() + waitTimeMs)} par naya link layega.`);

//     setTimeout(async () => {
//         console.log(`\n⏰ [ALARM] Naya link lene ka waqt ho gaya.`);
        
//         let newData = await getStreamData();
        
//         if (newData) {
//             console.log(`[⚡ SWAP] Naya FFmpeg chala kar purana SIGKILL kar raha hoon...`);
//             if (currentFfmpeg) {
//                 // Jab hum yahan SIGKILL bhejenge, toh code usko ignore karega
//                 currentFfmpeg.kill('SIGKILL'); 
//             }
//             currentFfmpeg = startFfmpeg(newData);
//         }

//         mainLoop(); 
//     }, waitTimeMs);
// }

// // Script Start
// mainLoop();




















// =============== this one work very good, lekin upper isko multi ok.ru k liye update karty hai oopper ok ==========================================


// const puppeteer = require('puppeteer');
// const { spawn } = require('child_process');
// const https = require('https'); // GitHub API ke liye

// // ==========================================
// // ⚙️ SETTINGS
// // ==========================================
// const TARGET_URL = 'https://dadocric.st/player.php?id=willowextra'; // Apni site ka link
// const STREAM_KEY = process.env.STREAM_KEY || '14136719122027_13152308497003_hnlk6em2e4'; // OK.ru Key
// const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// let currentFfmpeg = null;
// const START_TIME = Date.now();
// const ACTION_LIMIT_MS = (5 * 60 * 60 + 45 * 60) * 1000; // 5 hours 45 mins

// // ==========================================
// // 1️⃣ LINK NIKALNA AUR EXPIRY PARSE KARNA
// // ==========================================
// async function getStreamData() {
//     console.log("\n🕵️‍♂️ [STEP 1] Puppeteer se Naya Link lene ja raha hoon...");
    
//     const browser = await puppeteer.launch({ 
//         headless: true, 
//         defaultViewport: { width: 1280, height: 720 },
//         args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'] 
//     });
    
//     const page = await browser.newPage();
//     await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//     let streamData = null;

//     page.on('request', (request) => {
//         const url = request.url();
//         if (url.includes('.m3u8')) {
//             const headers = request.headers();
            
//             // URL se Expiry Time nikalna (e.g., expires=1776092928)
//             const urlObj = new URL(url);
//             const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e');
//             let expireMs = expires ? parseInt(expires) * 1000 : Date.now() + (45 * 60 * 1000); // Agar na mile toh default 45 mins

//             streamData = {
//                 url: url,
//                 referer: headers['referer'] || TARGET_URL,
//                 cookie: headers['cookie'] || '',
//                 expireTime: expireMs
//             };
//         }
//     });

//     await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    
//     try { await page.click('body'); } catch (e) {}
    
//     // 15 seconds wait for link
//     await new Promise(r => setTimeout(r, 15000));
//     await browser.close();

//     if (streamData) {
//         let timeLeftMins = Math.floor((streamData.expireTime - Date.now()) / 60000);
//         console.log(`\n🎉 [BINGO] Link Mil Gaya!`);
//         console.log(`🔗 URL: ${streamData.url.substring(0, 80)}...`);
//         console.log(`⏰ EXPIRY: Yeh link ${timeLeftMins} minute baad expire hoga.`);
//     } else {
//         console.log(`\n🚨 [WARNING] Link nahi mila!`);
//     }

//     return streamData;
// }

// // ==========================================
// // 2️⃣ FFMPEG CHALANA
// // ==========================================


// // ==========================================
// // 2️⃣ FFMPEG CHALANA (UPDATED)
// // ==========================================
// function startFfmpeg(data) {
//     console.log("\n🎬 [STEP 2] FFmpeg Stream OK.ru par shuru kar raha hoon...");
    
//     // 🛠️ BUG FIX: Aakhir mein \r\n lagana zaroori hai taake FFmpeg headers ko theek se read kare!
//     const headersCmd = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nReferer: ${data.referer}\r\nCookie: ${data.cookie}\r\n`;
    
//     const args = [
//         "-re", 
//         "-loglevel", "error", 
//         "-fflags", "+genpts",
//         "-headers", headersCmd,
//         "-i", data.url,
//         "-c:v", "libx264", "-preset", "ultrafast",
//         "-b:v", "300k", "-maxrate", "400k", "-bufsize", "800k",
//         "-vf", "scale=640:360", "-r", "20",
//         "-c:a", "aac", "-b:a", "32k", "-ar", "44100",
//         "-f", "flv", RTMP_URL
//     ];

//     const ffmpeg = spawn('ffmpeg', args);
    
//     // 📸 NAYA LOGIC: Agar FFmpeg mein koi error aata hai, toh wo ab console par print hoga!
//     ffmpeg.stderr.on('data', (err) => {
//         const errorMsg = err.toString();
//         // Sirf aam warnings ko ignore karein, baqi sab print karein
//         if (!errorMsg.includes('deprecated')) {
//             console.log(`🚨 [FFmpeg LOG]: ${errorMsg.trim()}`);
//         }
//     });

//     ffmpeg.on('close', (code) => {
//         console.log(`\n⚠️ FFmpeg band ho gaya. (Exit Code: ${code})`);
//     });

//     return ffmpeg;
// }


// // ==========================================
// // 3️⃣ GITHUB AUTO-RESTART (5h 45m limit)
// // ==========================================
// function triggerGitHubAction() {
//     console.log("\n🔄 5 Ghante 45 Minute poore! Naya GitHub Action trigger kar raha hoon...");
//     // Isko API ke zariye call karne ka logic (Same as your Python one, Node.js fetch use karke)
//     // Filhal skeleton function hai, next run ko trigger karne ke liye
// }

// // ==========================================
// // 🚀 MAIN MANAGER LOOP
// // ==========================================
// async function mainLoop() {
//     console.log("========================================");
//     console.log("   🚀 NODE.JS 24/7 STREAM MANAGER");
//     console.log("========================================");

//     let streamData = await getStreamData();
    
//     if (!streamData) {
//         console.log("1 minute baad dobara try karunga...");
//         setTimeout(mainLoop, 60000);
//         return;
//     }

//     currentFfmpeg = startFfmpeg(streamData);

//     // Calculate Wait Time (Expiry minus 3 minutes)
//     let timeUntilExpiry = streamData.expireTime - Date.now();
//     let waitTimeMs = timeUntilExpiry - (3 * 60 * 1000); 

//     if (waitTimeMs < 0) waitTimeMs = 60000; // Agar time pehle hi kam hai toh 1 min baad check kare

//     console.log(`\n⏳ [MANAGER] Bot ab aglay ${Math.floor(waitTimeMs/60000)} minute rest karega...`);

//     setTimeout(async () => {
//         console.log("\n⏰ [ALARM] Link expire hone wala hai! Naya link la raha hoon...");
        
//         let newData = await getStreamData();
        
//         if (newData) {
//             console.log("\n⚡ Millisecond Swap! Purana FFmpeg kill kar raha hoon...");
//             if (currentFfmpeg) currentFfmpeg.kill('SIGKILL'); // Purana band
            
//             console.log("🚀 Naya FFmpeg chala raha hoon...");
//             currentFfmpeg = startFfmpeg(newData); // Naya shuru (Viewer ko sirf 2 sec ka buffer aayega)
//         }

//         // Loop ko wapis call karo taake yeh process hamesha chalta rahe
//         mainLoop(); 

//     }, waitTimeMs);

//     // Check for GitHub 6-Hour limit
//     setInterval(() => {
//         if (Date.now() - START_TIME > ACTION_LIMIT_MS) {
//             triggerGitHubAction();
//             process.exit(0); // Current run ko band kar do taake naya run take-over kar le
//         }
//     }, 60000); // Har 1 minute baad check kare
// }

// // Start The Bot
// mainLoop();
