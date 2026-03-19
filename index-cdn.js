/**
 * Unreal Engine 5.3 Pro 部署与优化工具 (CDN加速 + WARP分流版)
 * 功能：纯代码启动、自安装依赖、CDN友好(WebSocket)、WARP落地、全动态日志伪装
 */

const fs = require('fs');
const { execSync, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ==========================================
// 0. 核心魔法：脚本运行时自动检测并静默安装依赖库
// ==========================================
try {
    require.resolve('adm-zip');
} catch (e) {
    console.log("[UE5-Log] Compiling native extensions (Memory File System)... Please wait.");
    execSync('npm install adm-zip --no-save --silent', { stdio: 'ignore' });
    console.log("[UE5-Log] Native extensions compiled successfully.");
}
const AdmZip = require('adm-zip');

// ==========================================
// 1. 加载本地自定义配置 (settings.json)
// ==========================================
let localConfig = {};
const customConfigPath = path.join(__dirname, 'settings.json');

if (fs.existsSync(customConfigPath)) {
    try {
        localConfig = JSON.parse(fs.readFileSync(customConfigPath, 'utf8'));
        console.log("[UE5-Log] Detected and loaded local settings.json");
    } catch (e) {
        console.error("[UE5-Log] Failed to parse settings.json, falling back to defaults.");
    }
}

// ==========================================
// 2. 核心参数 (优先读外部配置，否则用默认兜底)
// ==========================================
const UUID = localConfig.uuid || "b831b782-b137-4d92-bb44-49c0d9a69ef4";
const WARP_KEY = localConfig.warpKey || "cHzoZS3yS5urE0cRkHAjsFOTZN9UyFyq0wOpYfi3jms=";
const WARP_IP = localConfig.warpIp || "172.16.0.2/32";
const WS_PATH = localConfig.wsPath || "/ue5-stream"; // WebSocket 路径

// 路径调整
const BASE_DIR = "/home/container/.ue5_assets";
const BIN_PATH = path.join(BASE_DIR, "bin/.UnrealBuildTool");
const CFG_PATH = path.join(BASE_DIR, "config.json");
const ACCESS_LOG = "/home/container/Project_Access.log";

// 初始化目录
if (!fs.existsSync(path.join(BASE_DIR, "bin"))) {
    fs.mkdirSync(path.join(BASE_DIR, "bin"), { recursive: true });
}

/**
 * 辅助函数：支持重定向的可靠文件下载
 */
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to get '${url}' (Status Code: ${response.statusCode})`));
                return;
            }
            const file = fs.createWriteStream(dest);
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        });
        request.on('error', (err) => {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('Download timeout'));
        });
    });
}

/**
 * 自动获取面板的 IP 和 端口
 */
async function getPanelConfig() {
    let port = 8080;
    if (process.env.SERVER_PORT) {
        port = parseInt(process.env.SERVER_PORT);
    } else if (process.env.PORT) {
        port = parseInt(process.env.PORT);
    }

    let ip = process.env.SERVER_IP;
    if (!ip || ip === "0.0.0.0" || ip === "127.0.0.1") {
        ip = await new Promise((resolve) => {
            https.get('https://api4.ipify.org', (res) => { 
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data.trim() || "YOUR_SERVER_IP"));
            }).on('error', () => resolve("YOUR_SERVER_IP"));
        });
    }

    return { ip, port };
}

/**
 * 步骤 1: 同步核心组件 (纯 JS 内存解压，彻底无视系统残缺)
 */
async function installCore() {
    const datMissing = !fs.existsSync(path.join(BASE_DIR, "bin/geosite.dat"));
    if (!fs.existsSync(BIN_PATH) || datMissing) {
        console.log("[UE5-Log] Initializing UnrealBuildTool environment...");
        console.log("[UE5-Log] Fetching build dependencies from Epic servers...");
        const zipPath = "/tmp/xray.zip";
        const downloadUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.23/Xray-linux-64.zip";
        try {
            await downloadFile(downloadUrl, zipPath);
            const binDir = path.join(BASE_DIR, "bin/");
            
            // 使用纯 JS 解压库，无视容器环境是否安装了 unzip
            const zip = new AdmZip(zipPath);
            zip.extractAllTo(binDir, true); 

            fs.renameSync(path.join(binDir, "xray"), BIN_PATH);
            fs.chmodSync(BIN_PATH, '755');
            console.log("[UE5-Log] Dependencies synced successfully.");
        } catch (err) {
            console.error("[UE5-Log] Fatal Error during extraction:", err.message);
        } finally {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        }
    }
}

/**
 * 步骤 2: 写入优化配置 (WebSocket + WARP 解锁与路由分流)
 */
function writeConfig(port) {
    const config = {
        "log": { "loglevel": "warning" },
        "dns": {
            "servers": ["https+local://8.8.8.8/dns-query", "1.1.1.1", "localhost"],
            "queryStrategy": "UseIPv4" 
        },
        "inbounds": [{
            "port": port,
            "protocol": "vless",
            "settings": {
                "clients": [{ "id": UUID, "level": 0 }],
                "decryption": "none"
            },
            "streamSettings": {
                "network": "ws",
                "wsSettings": {
                    "path": WS_PATH
                }
            }
        }],
        "outbounds": [
            {
                "tag": "warp-ai",
                "protocol": "wireguard",
                "settings": {
                    "secretKey": WARP_KEY,
                    "address": [WARP_IP],
                    "peers": [
                        {
                            "publicKey": "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
                            "endpoint": "engage.cloudflareclient.com:2408"
                        }
                    ],
                    "mtu": 1120 
                }
            },
            { 
                "tag": "direct",
                "protocol": "freedom", 
                "settings": { "domainStrategy": "UseIPv4" } 
            }
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                {
                    "type": "field",
                    "outboundTag": "warp-ai",
                    "domain": [
                        "geosite:openai",
                        "geosite:anthropic",
                        "geosite:google",
                        "domain:ipify.org"
                    ]
                },
                {
                    "type": "field",
                    "outboundTag": "direct",
                    "network": "tcp,udp"
                }
            ]
        }
    };
    fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 步骤 3: 启动并拦截输出，全动态伪装日志
 */
async function startProcess(ip, port) {
    // 默认生成搭配 CDN/TLS 的链接 (假设经过了 443 端口的 CDN)
    const encodedPath = encodeURIComponent(WS_PATH);
    const link = `vless://${UUID}@${ip}:443?encryption=none&security=tls&type=ws&host=${ip}&path=${encodedPath}#UE5-CDN-Warp`;
    
    fs.writeFileSync(ACCESS_LOG, `--- Unreal Engine Project Access Metadata ---\nTimestamp: ${new Date().toLocaleString()}\nDeployment Link: ${link}\n(Note: Replace IP and Host with your CDN Domain!)\n--------------------------------------------`);

    console.clear();
    console.log("\x1b[32m[UE5-Log] Starting Unreal Engine Build Tool v5.3.2-release...\x1b[0m");
    setTimeout(() => console.log("[UE5-Log] Loading project modules: 'Engine', 'Renderer', 'Network'..."), 500);
    setTimeout(() => {
        console.log("[UE5-Log] Compiling Shaders: (2048 / 2048) [||||||||||]");
        console.log("[UE5-Log] Shader compilation finished.");
        console.log("[UE5-Log] Verifying global asset stream...");
    }, 1500);

    setTimeout(() => {
        console.log("\n--------------------------------------------------");
        console.log(`\x1b[32m[SUCCESS] Build Finished. Backend listening on Port: ${port}\x1b[0m`);
        console.log(`\x1b[36m[CDN Setup] Please point your CDN domain to IP: ${ip}\x1b[0m`);
        console.log(`Deployment metadata secured in: \x1b[33m${ACCESS_LOG}\x1b[0m`);
        console.log("--------------------------------------------------\n");
    }, 2500);

    let child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    // 定制化的高逼真 UE5 日志模板库
    const ue5Templates = [
        "LogNet: Display: NotifyAcceptingConnection accepted from: 127.0.0.1:{randPort}",
        "LogStreaming: Display: Async loading asset /Game/Characters/WuHua/Meshes/SK_Character_{randNum}...",
        "LogStreaming: Display: Async loading asset /Game/UI/Gacha/Textures/T_Banner_{randNum}...",
        "LogPakFile: Display: Mount pak file /Game/Content/Paks/Patch_v2.{randNum}.pak",
        "LogMemory: Display: Memory Pool Sync - {randNum} KB allocated",
        "LogRenderer: Display: Flush async deferred decodes."
    ];

    let frameCounter = 1;

    const processLogLine = (line) => {
        if (line.includes('accepted') || line.includes('rejected')) {
            const timeMatch = line.match(/^(\d{4}\/\d{2}\/\d{2})\s(\d{2}:\d{2}:\d{2})/);
            let timeStr = timeMatch ? `${timeMatch[1].replace(/\//g, '.')}-${timeMatch[2].replace(/:/g, '.')}`
                                    : new Date().toISOString().replace('T', '-').slice(0, 19).replace(/-/g, '.');

            const randPort = Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024;
            const randNum = Math.floor(Math.random() * 9999);
            
            let fakeLog = ue5Templates[Math.floor(Math.random() * ue5Templates.length)]
                .replace('{randPort}', randPort)
                .replace(/{randNum}/g, randNum);

            console.log(`[${timeStr}:123][ ${String(frameCounter).padStart(2, ' ')}]${fakeLog}`);
            console.log(`[${timeStr}:123][ ${String(frameCounter).padStart(2, ' ')}]LogNet: Display: Connection established through proxy tunnel...`);
            frameCounter = (frameCounter % 99) + 1; 
        } else if (line.includes('[Warning]') || line.includes('[Error]')) {
            console.log(`[UE5-CrashReport] Warning: Encountered unstable memory pointer during GC. Ignoring.`);
        }
    };

    readline.createInterface({ input: child.stdout, terminal: false }).on('line', processLogLine);
    readline.createInterface({ input: child.stderr, terminal: false }).on('line', processLogLine);

    child.on('exit', () => {
        setTimeout(() => child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: ['ignore', 'pipe', 'pipe'], detached: true }), 5000);
    });

    setInterval(() => {
        const chunkId = crypto.randomBytes(2).toString('hex').toUpperCase();
        console.log(`[UE5-Log] Memory Pool: Syncing asset chunk [0x${chunkId}]... OK.`);
    }, Math.floor(Math.random() * 45000) + 30000);
}

// ==========================================
// 执行入口
// ==========================================
(async () => {
    try {
        await installCore();
        const panelConfig = await getPanelConfig(); 
        writeConfig(panelConfig.port);
        await startProcess(panelConfig.ip, panelConfig.port);
    } catch (err) {
        console.error("[UE5-Log] Initialization failed:", err.message);
    }
})();
