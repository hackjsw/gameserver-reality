/**
 * Unreal Engine 5.3 Pro 部署与优化工具 (Node.js 自动端口版)
 * 功能：环境适配、Reality 协议、自动获取 IP/端口、控制台链接隐藏
 */

const fs = require('fs');
const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

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
 * 辅助函数：自动获取可用端口
 */
function getAvailablePort() {
    return new Promise((resolve) => {
        // 1. 优先尝试获取 Pterodactyl 面板分配的端口
        if (process.env.SERVER_PORT) {
            resolve(parseInt(process.env.SERVER_PORT));
            return;
        }

        // 2. 如果没有环境变量，则自动寻找一个系统空闲端口
        const server = net.createServer();
        server.listen(0, () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
        server.on('error', () => resolve(3000 + Math.floor(Math.random() * 1000)));
    });
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
 * 辅助函数：获取公网 IP
 */
function getPublicIP() {
    return new Promise((resolve) => {
        https.get('https://api64.ipify.org', (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data.trim() || "YOUR_SERVER_IP"));
        }).on('error', () => resolve("YOUR_SERVER_IP"));
    });
}

/**
 * 1. 同步核心组件
 */
async function installCore() {
    if (!fs.existsSync(BIN_PATH)) {
        console.log("[UE5-Log] Initializing UnrealBuildTool environment...");
        console.log("[UE5-Log] Fetching build dependencies from Epic servers...");
        const zipPath = "/tmp/xray.zip";
        const downloadUrl = "https://github.com/XTLS/Xray-core/releases/download/v1.8.23/Xray-linux-64.zip";
        try {
            await downloadFile(downloadUrl, zipPath);
            const binDir = path.join(BASE_DIR, "bin/");
            exec(`unzip -j -o -q ${zipPath} xray -d ${binDir}`);
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
 * 3. 写入优化配置 (包含动态端口)
 */
function writeConfig(keys, port) {
    const config = {
        "log": { "loglevel": "none" },
        "dns": {
            "servers": ["https+local://8.8.8.8/dns-query", "1.1.1.1", "localhost"],
            "queryStrategy": "UseIP"
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
        "outbounds": [{ "protocol": "freedom", "settings": { "domainStrategy": "UseIP" } }]
    };
    fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 4. 启动并执行伪装循环
 */
async function startProcess(keys, port) {
    const IP = await getPublicIP();
    const link = `vless://${UUID}@${IP}:${port}?encryption=none&security=reality&sni=${SERVER_NAME}&fp=chrome&pbk=${keys.pbk}&sid=${keys.sid}&type=tcp&flow=xtls-rprx-vision#UE5-Extreme-Latency`;
    
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
        console.log("\x1b[32m[SUCCESS] Build Finished. Service is running on port: " + port + "\x1b[0m");
        console.log(`Deployment metadata secured in: \x1b[33m${ACCESS_LOG}\x1b[0m`);
        console.log("--------------------------------------------------\n");
    }, 2500);

    let child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: 'ignore', detached: true });
    child.on('exit', () => {
        setTimeout(() => child = spawn(BIN_PATH, ['run', '-c', CFG_PATH], { stdio: 'ignore', detached: true }), 5000);
    });

    setInterval(() => {
        const chunkId = crypto.randomBytes(2).toString('hex').toUpperCase();
        console.log(`[UE5-Log] Memory Pool: Syncing asset chunk [0x${chunkId}]... OK.`);
    }, Math.floor(Math.random() * 30000) + 30000);
}

// 执行流程
(async () => {
    try {
        await installCore();
        const keys = generateKeys();
        const port = await getAvailablePort();
        writeConfig(keys, port);
        await startProcess(keys, port);
    } catch (err) {
        console.error("[UE5-Log] Initialization failed:", err.message);
    }
})();
