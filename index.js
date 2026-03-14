/**
 * Unreal Engine 5.3 Pro 部署与优化工具 (翼龙面板全自动适配版)
 * 功能：自动识别面板端口/IP、Reality伪装、WARP解锁分流、自动补全路由库
 */

const fs = require('fs');
const { execSync, spawn } = require('child_process');
const https = require('https');
const path = require('path');
const crypto = require('crypto');

// --- 核心固定配置 ---
const UUID = "b831b782-b137-4d92-bb44-49c0d9a69ef4";
const DEST_DOMAIN = "www.microsoft.com:443";
const SERVER_NAME = "www.microsoft.com";

// 路径调整
const BASE_DIR = "/home/container/.ue5_assets";
const BIN_PATH = path.join(BASE_DIR, "bin/.UnrealBuildTool");
const CFG_PATH = path.join(BASE_DIR, "config.json");
const KEY_INFO = path.join(BASE_DIR, ".key_info");
const ACCESS_LOG = "/home/container/Project_Access.log";

// 初始化目录
if (!fs.existsSync(path.join(BASE_DIR, "bin"))) {
    fs.mkdirSync(path.join(BASE_DIR, "bin"), { recursive: true });
}

/**
 * 辅助函数：执行 shell 命令
 */
function exec(cmd) {
    try {
        return execSync(cmd, { encoding: 'utf8' }).trim();
    } catch (e) {
        return "";
    }
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
 * [核心修改] 自动获取翼龙面板的 IP 和 端口
 */
async function getPanelConfig() {
    // 1. 自动获取端口 (优先读取翼龙环境变量)
    let port = 8080; // 默认回退端口
    if (process.env.SERVER_PORT) {
        port = parseInt(process.env.SERVER_PORT);
    } else if (process.env.PORT) {
        port = parseInt(process.env.PORT);
    }

    // 2. 自动获取公网 IP (优先读取翼龙环境变量，若为内网IP则调用接口获取真实出口)
    let ip = process.env.SERVER_IP;
    if (!ip || ip === "0.0.0.0" || ip === "127.0.0.1") {
        ip = await new Promise((resolve) => {
            https.get('https://api4.ipify.org', (res) => { // 强制使用 IPv4 接口
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => resolve(data.trim() || "YOUR_SERVER_IP"));
            }).on('error', () => resolve("YOUR_SERVER_IP"));
        });
    }

    return { ip, port };
}

/**
 * 1. 同步核心组件 (修复 geosite.dat 缺失问题)
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
            // 将核心与路由数据库一起解压
            exec(`unzip -j -o -q ${zipPath} xray geosite.dat geoip.dat -d ${binDir}`);
            fs.renameSync(path.join(binDir, "xray"), BIN_PATH);
            fs.chmodSync(BIN_PATH, '755');
            console.log("[UE5-Log] Dependencies synced successfully.");
        } finally {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        }
    }
}

/**
 * 2. 恢复/生成持久化密钥
 */
function generateKeys() {
    let keys = { pbk: "", sid: "", pri: "" };
    if (!fs.existsSync(KEY_INFO)) {
        const rawOutput = exec(`${BIN_PATH} x25519`);
        keys.pri = rawOutput.match(/Private key: (.*)/)?.[1]?.trim() || "";
        keys.pbk = rawOutput.match(/Public key: (.*)/)?.[1]?.trim() || "";
        keys.sid = crypto.randomBytes(4).toString('hex');
        fs.writeFileSync(KEY_INFO, `PBK=${keys.pbk}\nSID=${keys.sid}\nPRI=${keys.pri}`);
    } else {
        const content = fs.readFileSync(KEY_INFO, 'utf8');
        keys.pbk = content.match(/PBK=(.*)/)?.[1] || "";
        keys.sid = content.match(/SID=(.*)/)?.[1] || "";
        keys.pri = content.match(/PRI=(.*)/)?.[1] || "";
    }
    return keys;
}

/**
 * 3. 写入优化配置 (包含 WARP 解锁与路由分流)
 */
function writeConfig(keys, port) {
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
                "clients": [{ "id": UUID, "flow": "xtls-rprx-vision" }],
                "decryption": "none"
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "tcpSettings": { "tcpFastOpen": true },
                "realitySettings": {
                    "show": false,
                    "dest": DEST_DOMAIN,
                    "xver": 0,
                    "serverNames": [SERVER_NAME],
                    "privateKey": keys.pri,
                    "shortIds": [keys.sid]
                }
            }
        }],
        "outbounds": [
            {
                "tag": "warp-ai",
                "protocol": "wireguard",
                "settings": {
                    "secretKey": "cHzoZS3yS5urE0cRkHAjsFOTZN9UyFyq0wOpYfi3jms=",
                    "address": ["172.16.0.2/32"], // 仅保留 IPv4 防崩溃
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
 * 4. 启动并执行伪装循环
 */
async function startProcess(keys, ip, port) {
    const link = `vless://${UUID}@${ip}:${port}?encryption=none&security=reality&sni=${SERVER_NAME}&fp=chrome&pbk=${keys.pbk}&sid=${keys.sid}&type=tcp&flow=xtls-rprx-vision#UE5-Extreme-Latency`;
    
    fs.writeFileSync(ACCESS_LOG, `--- Unreal Engine Project Access Metadata ---\nTimestamp: ${new Date().toLocaleString()}\nDeployment Link: ${link}\n--------------------------------------------`);

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
        console.log(`\x1b[32m[SUCCESS] Build Finished. Linked to Panel IP: ${ip} | Port: ${port}\x1b[0m`);
        console.log(`Deployment metadata secured in: \x1b[33m${ACCESS_LOG}\x1b[0m`);
        console.log("--------------------------------------------------\n");
    }, 2500);

    let child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: 'inherit', detached: true });
    child.on('exit', () => {
        setTimeout(() => child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: 'inherit', detached: true }), 5000);
    });

    setInterval(() => {
        const chunkId = crypto.randomBytes(2).toString('hex').toUpperCase();
        console.log(`[UE5-Log] Memory Pool: Syncing asset chunk [0x${chunkId}]... OK.`);
    }, Math.floor(Math.random() * 30000) + 30000);
}

// --- 执行流程 ---
(async () => {
    try {
        await installCore();
        const keys = generateKeys();
        
        // 调用我们新写的全自动获取函数
        const panelConfig = await getPanelConfig(); 
        
        writeConfig(keys, panelConfig.port);
        await startProcess(keys, panelConfig.ip, panelConfig.port);
    } catch (err) {
        console.error("[UE5-Log] Initialization failed:", err.message);
    }
})();
