陛下，恭喜大功告成！这套“Worker前台 + CDN中转 + 端口回源”的架构非常精妙，兼顾了隐藏真实 IP、TLS 伪装和防封锁，极其适合日常折腾和深度定制。

为了方便您日后查阅和快速复现，我为您整理了一份标准化的 `README.md` 文档。您可以直接将以下内容保存为文件。

---

# 📦 UE5 Pro 部署与 CDN 加速架构指南

本指南记录了基于 `VLESS + WebSocket + Cloudflare CDN + Worker反代` 的全套部署流程。

## 🛠️ 第一步：服务端部署
1. 将部署脚本（如 `ue5_deploy.js`）上传至服务器/容器。
2. 确保脚本中监听的协议为 `ws`，路径为 `/ue5-stream`。
3. 确保脚本监听的内部端口（如面板分配的端口）已知，例如：**`3756`**。
4. 启动脚本，确认后台正常输出 UE5 伪装日志。

---

## ☁️ 第二步：Cloudflare 基础配置 (DNS & SSL)
1. **添加 DNS 记录**：
   * 登录 Cloudflare 控制台，进入目标域名（如 `hnlj.dpdns.org`）。
   * 添加一条 `A 记录`，名称填写 `syntex`，IP 填写源服务器的真实 IP。
   * **必须开启代理状态（小黄云）**。
2. **修改 SSL/TLS 模式（🔥 极其重要）**：
   * 进入左侧菜单 `SSL/TLS` -> `概述`。
   * 将加密模式严格设置为 **灵活 (Flexible)**。
   * *(注：若设置为“完全”，由于源服务器未配置证书，将导致 `SSL handshake failed` 报错。)*

---

## 🔀 第三步：配置回源规则 (Origin Rules)
此步骤用于将 CDN 接收到的 443 端口流量，精准穿透并重定向到服务器的真实端口。
1. 进入左侧菜单 `规则 (Rules)` -> `Origin Rules` -> `创建规则`。
2. **匹配条件**：
   * 字段 (Field)：`主机名 (Hostname)`
   * 运算符 (Operator)：`等于 (equals)`
   * 值 (Value)：`***.***.com` *(必须是开启了小黄云的域名)*
3. **重写规则**：
   * 向下滚动至 `目标端口 (Destination port)`。
   * 选择 `重写到 (Rewrite to...)`，填入源服务器监听端口：**`PORT`**。
4. 保存并部署。

---

## 🤖 第四步：部署 CF Worker (前台反代)
通过 Worker 作为客户端直接连接的入口，进一步保护主域名并优化路由。
1. 在 Cloudflare 控制台创建并部署一个全新的 Worker。
2. 填入以下反代代码：
```javascript
export default {
    async fetch(request, env) {
        let url = new URL(request.url);
        if (url.pathname.startsWith('/')) {
            var arrStr = [
                'YOUR HOSTNAME', // 此处填写开启了小黄云的中转域名
            ];
            url.protocol = 'https:'
            url.hostname = getRandomArray(arrStr)
            let new_request = new Request(url, request);
            return fetch(new_request);
        }
        return env.ASSETS.fetch(request);
    },
};
function getRandomArray(array) {
  const randomIndex = Math.floor(Math.random() * array.length);
  return array[randomIndex];
}
```
3. 保存并部署。
4. 在 Worker 的 `触发器 (Triggers)` 设置中，为其绑定自定义域名（如 `syn.hnlj.dpdns.org`），或者直接使用分配的 `*.workers.dev` 域名。

