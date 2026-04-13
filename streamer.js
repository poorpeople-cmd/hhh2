const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

// ==========================================
// ⚙️ SETTINGS & COUNTERS
// ==========================================
const TARGET_URL = process.env.TARGET_URL || 'https://dadocric.st/player.php?id=ptvsp'; 
const STREAM_ID = process.env.STREAM_ID || '1'; 

const MULTI_KEYS = {
    '1': '14136719122027_13152308497003_hnlk6em2e4',
    '2': '14136743566955_13152356600427_vmdsemtmo4',
    '3': '14136762048107_13152392710763_22fobqpsdi',
    '4': '14136778563179_13152426265195_c5quhoj2vm'
};

const STREAM_KEY = MULTI_KEYS[STREAM_ID] || MULTI_KEYS['1'];
const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

// 🛡️ CRITICAL LOGIC COUNTERS
let consecutiveLinkFails = 0;
let consecutiveFfmpegFails = 0;

let currentFfmpeg = null;
const START_TIME = Date.now();
const ACTION_LIMIT_MS = (5 * 60 * 60 + 45 * 60) * 1000;

function formatPKT(timestampMs) {
    return new Date(timestampMs).toLocaleString('en-US', {
        timeZone: 'Asia/Karachi', hour12: true, year: 'numeric', month: 'short',
        day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }) + " PKT";
}

// ==========================================
// 1️⃣ LINK EXTRACTION (WITH STRIKE LOGIC)
// ==========================================
async function getStreamData() {
    console.log(`\n[🔍 STEP 1] Puppeteer Chrome Start... (Koshish #${consecutiveLinkFails + 1})`);
    
    const browser = await puppeteer.launch({ 
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let streamData = null;

    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('.m3u8')) {
            const urlObj = new URL(url);
            const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e') || urlObj.searchParams.get('exp');
            let expireMs = expires ? parseInt(expires) * 1000 : Date.now() + (60 * 60 * 1000);

            streamData = {
                url: url,
                referer: request.headers()['referer'] || TARGET_URL,
                cookie: request.headers()['cookie'] || '',
                expireTime: expireMs
            };
        }
    });

    try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.click('body').catch(() => {});
        await new Promise(r => setTimeout(r, 15000));
    } catch (e) {
        console.log(`[❌ ERROR] Page load nahi ho saka.`);
    }
    
    await browser.close();

    if (streamData) {
        consecutiveLinkFails = 0; // Success! Counter reset
        console.log(`\n🎉 [BINGO] Link Extract Ho Gaya!`);
        console.log(`⏰ EXPIRY: ${formatPKT(streamData.expireTime)}`);
        return streamData;
    } else {
        consecutiveLinkFails++;
        console.log(`\n🚨 [WARNING] Link nahi mila. Strike: ${consecutiveLinkFails}/3`);
        
        if (consecutiveLinkFails >= 3) {
            console.log(`\n🛑 [FATAL] 3 baar consecutive link nahi mila. Bot ko safety ke liye stop kar raha hoon.`);
            process.exit(1); 
        }
        return null;
    }
}

// ==========================================
// 2️⃣ FFMPEG (WITH SMART ERROR DETECTION)
// ==========================================
function startFfmpeg(data) {
    console.log(`[🚀 STEP 2] FFmpeg Shuru... (Strike Counter: ${consecutiveFfmpegFails}/3)`);
    
    const headersCmd = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nReferer: ${data.referer}\r\nCookie: ${data.cookie}\r\n`;
    
    const args = [
        "-re", "-loglevel", "error", "-headers", headersCmd, "-i", data.url,
        "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "300k",
        "-vf", "scale=640:360", "-r", "20", "-c:a", "aac", "-b:a", "32k",
        "-f", "flv", RTMP_URL
    ];

    const ffmpeg = spawn('ffmpeg', args);
    const startTime = Date.now();
    let hasOkRuError = false; // 🛡️ Naya flag OK.ru ke errors ke liye

    // Error pakarne ka logic
    ffmpeg.stderr.on('data', (err) => {
        const msg = err.toString();
        // Agar ok.ru block kare (403, 404, connection refused)
        if (msg.includes("403 Forbidden") || msg.includes("Connection refused") || msg.includes("Input/output error")) {
            console.log(`🚨 [OK.RU BLOCKED]: ${msg.trim()}`);
            hasOkRuError = true; // Error detected
        }
    });

    // Close event - Yahan faisla hoga ke strike deni hai ya nahi
    ffmpeg.on('close', (code, signal) => {
        const duration = (Date.now() - startTime) / 1000;

        // 🛡️ NAYA LOGIC: Agar humne khud swap ke waqt SIGKILL bheja hai, toh strike nahi deni!
        if (signal === 'SIGKILL' || signal === 'SIGTERM') {
            console.log(`[♻️ SWAP CLEANUP] Purana FFmpeg successfully swap ho gaya.`);
            return; 
        }

        console.log(`\n⚠️ FFmpeg band ho gaya. (Code: ${code}, Duration: ${duration}s)`);

        // Strike sirf tab count hogi agar:
        // 1. OK.ru ne error diya ho (hasOkRuError)
        // 2. YA 2 minute chala hi na ho (Asli crash)
        if (hasOkRuError || (code !== 0 && duration < 120)) {
            consecutiveFfmpegFails++;
            console.log(`🚨 FFmpeg Strike lag gayi: ${consecutiveFfmpegFails}/3`);
            
            if (consecutiveFfmpegFails >= 3) {
                console.log(`\n🛑 [FATAL] OK.ru bar bar stream block kar raha hai (3 Strikes). Workflow khtam.`);
                process.exit(1);
            }
        } else if (duration >= 120) {
            consecutiveFfmpegFails = 0; // Agar 2 min chal gaya matlab sahi chal raha tha, toh reset.
        }
    });

    return ffmpeg;
}

// ==========================================
// 🚀 MAIN MANAGER LOOP
// ==========================================
async function mainLoop() {
    console.log(`\n[⏰ MANAGER] Time: ${formatPKT(Date.now())}`);

    let streamData = await getStreamData();
    
    if (!streamData) {
        console.log(`[🔄] 1 minute baad retry...`);
        setTimeout(mainLoop, 60000);
        return;
    }

    currentFfmpeg = startFfmpeg(streamData);

    let waitTimeMs = (streamData.expireTime - Date.now()) - (3 * 60 * 1000); 
    if (waitTimeMs < 0) waitTimeMs = 60000;

    console.log(`[⏳] Bot Alarm Set: ${formatPKT(Date.now() + waitTimeMs)} par naya link layega.`);

    setTimeout(async () => {
        console.log(`\n⏰ [ALARM] Naya link lene ka waqt ho gaya.`);
        
        let newData = await getStreamData();
        
        if (newData) {
            console.log(`[⚡ SWAP] Naya FFmpeg chala kar purana SIGKILL kar raha hoon...`);
            if (currentFfmpeg) {
                // Jab hum yahan SIGKILL bhejenge, toh code usko ignore karega
                currentFfmpeg.kill('SIGKILL'); 
            }
            currentFfmpeg = startFfmpeg(newData);
        }

        mainLoop(); 
    }, waitTimeMs);
}

// Script Start
mainLoop();




















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
