const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const https = require('https'); // GitHub API ke liye

// ==========================================
// ⚙️ SETTINGS
// ==========================================
const TARGET_URL = 'https://dadocric.st/player.php?id=willowextra'; // Apni site ka link
const STREAM_KEY = process.env.STREAM_KEY || '14136719122027_13152308497003_hnlk6em2e4'; // OK.ru Key
const RTMP_URL = `rtmp://vsu.okcdn.ru/input/${STREAM_KEY}`;

let currentFfmpeg = null;
const START_TIME = Date.now();
const ACTION_LIMIT_MS = (5 * 60 * 60 + 45 * 60) * 1000; // 5 hours 45 mins

// ==========================================
// 1️⃣ LINK NIKALNA AUR EXPIRY PARSE KARNA
// ==========================================
async function getStreamData() {
    console.log("\n🕵️‍♂️ [STEP 1] Puppeteer se Naya Link lene ja raha hoon...");
    
    const browser = await puppeteer.launch({ 
        headless: true, 
        defaultViewport: { width: 1280, height: 720 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--mute-audio'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let streamData = null;

    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('.m3u8')) {
            const headers = request.headers();
            
            // URL se Expiry Time nikalna (e.g., expires=1776092928)
            const urlObj = new URL(url);
            const expires = urlObj.searchParams.get('expires') || urlObj.searchParams.get('e');
            let expireMs = expires ? parseInt(expires) * 1000 : Date.now() + (45 * 60 * 1000); // Agar na mile toh default 45 mins

            streamData = {
                url: url,
                referer: headers['referer'] || TARGET_URL,
                cookie: headers['cookie'] || '',
                expireTime: expireMs
            };
        }
    });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    
    try { await page.click('body'); } catch (e) {}
    
    // 15 seconds wait for link
    await new Promise(r => setTimeout(r, 15000));
    await browser.close();

    if (streamData) {
        let timeLeftMins = Math.floor((streamData.expireTime - Date.now()) / 60000);
        console.log(`\n🎉 [BINGO] Link Mil Gaya!`);
        console.log(`🔗 URL: ${streamData.url.substring(0, 80)}...`);
        console.log(`⏰ EXPIRY: Yeh link ${timeLeftMins} minute baad expire hoga.`);
    } else {
        console.log(`\n🚨 [WARNING] Link nahi mila!`);
    }

    return streamData;
}

// ==========================================
// 2️⃣ FFMPEG CHALANA
// ==========================================
function startFfmpeg(data) {
    console.log("\n🎬 [STEP 2] FFmpeg Stream OK.ru par shuru kar raha hoon...");
    
    const headersCmd = `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\nReferer: ${data.referer}\r\nCookie: ${data.cookie}`;
    
    const args = [
        "-re", "-loglevel", "error", "-fflags", "+genpts",
        "-headers", headersCmd,
        "-i", data.url,
        "-c:v", "libx264", "-preset", "ultrafast",
        "-b:v", "300k", "-maxrate", "400k", "-bufsize", "800k",
        "-vf", "scale=640:360", "-r", "20",
        "-c:a", "aac", "-b:a", "32k", "-ar", "44100",
        "-f", "flv", RTMP_URL
    ];

    const ffmpeg = spawn('ffmpeg', args);
    
    ffmpeg.on('close', (code) => {
        console.log(`\n⚠️ FFmpeg band ho gaya. (Exit Code: ${code})`);
    });

    return ffmpeg;
}

// ==========================================
// 3️⃣ GITHUB AUTO-RESTART (5h 45m limit)
// ==========================================
function triggerGitHubAction() {
    console.log("\n🔄 5 Ghante 45 Minute poore! Naya GitHub Action trigger kar raha hoon...");
    // Isko API ke zariye call karne ka logic (Same as your Python one, Node.js fetch use karke)
    // Filhal skeleton function hai, next run ko trigger karne ke liye
}

// ==========================================
// 🚀 MAIN MANAGER LOOP
// ==========================================
async function mainLoop() {
    console.log("========================================");
    console.log("   🚀 NODE.JS 24/7 STREAM MANAGER");
    console.log("========================================");

    let streamData = await getStreamData();
    
    if (!streamData) {
        console.log("1 minute baad dobara try karunga...");
        setTimeout(mainLoop, 60000);
        return;
    }

    currentFfmpeg = startFfmpeg(streamData);

    // Calculate Wait Time (Expiry minus 3 minutes)
    let timeUntilExpiry = streamData.expireTime - Date.now();
    let waitTimeMs = timeUntilExpiry - (3 * 60 * 1000); 

    if (waitTimeMs < 0) waitTimeMs = 60000; // Agar time pehle hi kam hai toh 1 min baad check kare

    console.log(`\n⏳ [MANAGER] Bot ab aglay ${Math.floor(waitTimeMs/60000)} minute rest karega...`);

    setTimeout(async () => {
        console.log("\n⏰ [ALARM] Link expire hone wala hai! Naya link la raha hoon...");
        
        let newData = await getStreamData();
        
        if (newData) {
            console.log("\n⚡ Millisecond Swap! Purana FFmpeg kill kar raha hoon...");
            if (currentFfmpeg) currentFfmpeg.kill('SIGKILL'); // Purana band
            
            console.log("🚀 Naya FFmpeg chala raha hoon...");
            currentFfmpeg = startFfmpeg(newData); // Naya shuru (Viewer ko sirf 2 sec ka buffer aayega)
        }

        // Loop ko wapis call karo taake yeh process hamesha chalta rahe
        mainLoop(); 

    }, waitTimeMs);

    // Check for GitHub 6-Hour limit
    setInterval(() => {
        if (Date.now() - START_TIME > ACTION_LIMIT_MS) {
            triggerGitHubAction();
            process.exit(0); // Current run ko band kar do taake naya run take-over kar le
        }
    }, 60000); // Har 1 minute baad check kare
}

// Start The Bot
mainLoop();
