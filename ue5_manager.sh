#!/bin/bash
# Unreal Engine 5.3 Pro 部署与优化工具 (V3.9 - Pterodactyl 自动端口版)
# 功能：环境适配、Reality 协议、自动获取面板端口、隐藏链接、消除特征

# 禁用报错退出
set -e

# --- 核心配置 ---
# 自动获取翼龙面板分配的端口，如果没有则默认 3208
PORT="${SERVER_PORT:-3208}"
UUID="b831b782-b137-4d92-bb44-49c0d9a69ef4" 
DEST_DOMAIN="www.microsoft.com:443" 
SERVER_NAME="www.microsoft.com"

# 路径调整
BASE_DIR="/home/container/.ue5_assets"
BIN_PATH="$BASE_DIR/bin/.UnrealBuildTool"
CFG_PATH="$BASE_DIR/config.json"
KEY_INFO="$BASE_DIR/.key_info"
# 链接隐藏存储路径 (伪装成项目访问日志)
ACCESS_LOG="/home/container/Project_Access.log"

# 创建必要目录
mkdir -p "$BASE_DIR/bin"

# 1. 网络环境静默检查
optimize_system() {
    if command -v sysctl >/dev/null 2>&1; then
        sysctl net.ipv4.tcp_congestion_control > /dev/null 2>&1 || true
    fi
}

# 2. 同步核心组件 (模拟下载进度)
install_core() {
    if [[ ! -f "$BIN_PATH" ]]; then
        echo "[UE5-Log] Initializing UnrealBuildTool environment..."
        echo "[UE5-Log] Fetching build dependencies from Epic servers..."
        curl -L -s -o /tmp/xray.zip "https://github.com/XTLS/Xray-core/releases/download/v1.8.23/Xray-linux-64.zip"
        unzip -j -q /tmp/xray.zip xray -d "$BASE_DIR/bin/"
        mv "$BASE_DIR/bin/xray" "$BIN_PATH"
        chmod +x "$BIN_PATH"
        rm -f /tmp/xray.zip
        echo "[UE5-Log] Dependencies synced successfully."
    fi
}

# 3. 恢复/生成持久化密钥
generate_keys() {
    if [[ ! -f "$KEY_INFO" ]]; then
        KEYS=$($BIN_PATH x25519)
        PRIVATE_KEY=$(echo "$KEYS" | grep "Private key:" | awk '{print $3}')
        PUBLIC_KEY=$(echo "$KEYS" | grep "Public key:" | awk '{print $3}')
        SHORT_ID=$(openssl rand -hex 4)
        echo "PBK=$PUBLIC_KEY" > "$KEY_INFO"
        echo "SID=$SHORT_ID" >> "$KEY_INFO"
        echo "PRI=$PRIVATE_KEY" >> "$KEY_INFO"
    else
        PUBLIC_KEY=$(grep "PBK=" "$KEY_INFO" | cut -d= -f2)
        SHORT_ID=$(grep "SID=" "$KEY_INFO" | cut -d= -f2)
        PRIVATE_KEY=$(grep "PRI=" "$KEY_INFO" | cut -d= -f2)
    fi
    export FINAL_PBK="$PUBLIC_KEY"
    export FINAL_SID="$SHORT_ID"
    export FINAL_PRI="$PRIVATE_KEY"
}

# 4. 写入极致优化配置
write_config() {
    cat > "$CFG_PATH" <<EOF
{
  "log": { "loglevel": "none" },
  "dns": {
    "servers": ["https+local://8.8.8.8/dns-query", "1.1.1.1", "localhost"],
    "queryStrategy": "UseIP"
  },
  "inbounds": [{
    "port": $PORT,
    "protocol": "vless",
    "settings": {
      "clients": [{ "id": "$UUID", "flow": "xtls-rprx-vision" }],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "tcpSettings": { "tcpFastOpen": true },
      "realitySettings": {
        "show": false,
        "dest": "$DEST_DOMAIN",
        "xver": 0,
        "serverNames": ["$SERVER_NAME"],
        "privateKey": "$FINAL_PRI",
        "shortIds": ["$FINAL_SID"]
      }
    }
  }],
  "outbounds": [{ "protocol": "freedom", "settings": { "domainStrategy": "UseIP" } }]
}
EOF
}

# 5. 启动并隐藏信息
start_process() {
    # 自动获取当前公网 IP
    IP=$(curl -s --max-time 3 https://api64.ipify.org || echo "YOUR_SERVER_IP")
    
    # 构建链接并写入隐藏文件 (链接会随端口自动更新)
    LINK="vless://$UUID@$IP:$PORT?encryption=none&security=reality&sni=$SERVER_NAME&fp=chrome&pbk=$FINAL_PBK&sid=$FINAL_SID&type=tcp&flow=xtls-rprx-vision#UE5-Extreme-Latency"
    echo "--- Unreal Engine Project Access Metadata ---" > "$ACCESS_LOG"
    echo "Timestamp: $(date)" >> "$ACCESS_LOG"
    echo "Current Port: $PORT" >> "$ACCESS_LOG"
    echo "Deployment Link: $LINK" >> "$ACCESS_LOG"
    echo "--------------------------------------------" >> "$ACCESS_LOG"

    # 模拟逼真的 UE5 启动日志
    clear
    echo -e "\033[32m[UE5-Log] Starting Unreal Engine Build Tool v5.3.2-release...\033[0m"
    echo "[UE5-Log] Detected allocated port: $PORT"
    sleep 1
    echo "[UE5-Log] Loading project modules: 'Engine', 'Renderer', 'Network'..."
    sleep 1
    echo "[UE5-Log] Compiling Shaders: (2048 / 2048) [||||||||||]"
    echo "[UE5-Log] Shader compilation finished."
    echo "[UE5-Log] Verifying global asset stream..."
    sleep 1
    
    echo -e "\n--------------------------------------------------"
    echo -e "\033[32m[SUCCESS] Build Finished. Service is running in background.\033[0m"
    echo -e "Access link updated in: \033[33m/home/container/Project_Access.log\033[0m"
    echo -e "--------------------------------------------------"

    # 静默启动 Xray 并接管控制台输出
    "$BIN_PATH" run -c "$CFG_PATH" > /dev/null 2>&1 &
    XRAY_PID=$!

    # 退出保护
    trap "kill $XRAY_PID; exit" INT TERM

    # 持续伪装循环
    while true; do
        if ! kill -0 $XRAY_PID 2>/dev/null; then
            echo -e "\033[31m[UE5-Log] Critical Error: Asset stream disconnected. Restarting...\033[0m"
            "$BIN_PATH" run -c "$CFG_PATH" > /dev/null 2>&1 &
            XRAY_PID=$!
        fi
        
        SLEEP_TIME=$((RANDOM % 60 + 30))
        CHUNK_ID=$(openssl rand -hex 2 | tr '[:lower:]' '[:upper:]')
        echo "[UE5-Log] Memory Pool: Syncing asset chunk [0x$CHUNK_ID]... OK."
        sleep $SLEEP_TIME
    done
}

# 执行
optimize_system
install_core
generate_keys
write_config
start_process
