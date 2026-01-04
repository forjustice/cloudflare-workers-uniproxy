# VPS 部署方案：Cloudflare Workers 迁移至 Node.js + Express

将现有的 Cloudflare Workers 代理服务迁移至标准 Node.js + Express 应用，以便部署到 VPS。

> [!IMPORTANT]
> 本方案要求 **Node.js 22.0.0 或更高版本**，使用内置 `fetch` API，无需额外依赖。

---

## 现有代码分析

### 核心功能

现有 [index.js](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/index.js) 是一个 **CORS 代理服务**，主要功能包括：

1. **CORS 预检处理**：响应 `OPTIONS` 请求，返回允许跨域的头信息
2. **URL 解析**：从请求 URL 中提取目标 URL 和自定义 Headers
3. **请求转发**：将请求转发到目标服务器，支持 GET/POST/PUT/PATCH/DELETE
4. **响应处理**：将目标服务器的响应添加 CORS 头后返回

### Cloudflare Workers 特有 API

| API | 用途 | Express 替代方案 |
|-----|------|-----------------|
| `addEventListener('fetch', ...)` | 监听请求 | `app.all('/*', ...)` |
| `Request` 对象 | 请求封装 | Express `req` 对象 |
| `Response` 对象 | 响应封装 | Express `res` 对象 |
| `Headers` 对象 | 头信息操作 | 普通对象 / Express headers |
| `fetch()` | 发起 HTTP 请求 | Node.js 22+ 内置 `fetch` |

---

## 迁移方案设计

### 目录结构

```
cloudflare-workers-uniproxy/
├── index.js                   # 原 Cloudflare Workers 代码（保留）
├── VPS_DEPLOY_GUIDE.md        # 本文档
├── vps-deploy/                # VPS 部署目录（新增）
│   ├── package.json           # 项目依赖配置
│   ├── server.js              # Express 服务器入口
│   ├── lib/
│   │   └── proxy.js           # 代理核心逻辑
│   └── ecosystem.config.js    # PM2 配置文件
└── README.md
```

### 依赖清单

```json
{
  "name": "uniproxy-vps",
  "version": "1.0.0",
  "description": "CORS Proxy for VPS deployment",
  "main": "server.js",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.21.0"
  }
}
```

> [!NOTE]
> Node.js 22+ 内置 `fetch` API，无需安装 `node-fetch`。  
> 使用 `--watch` 参数实现开发环境热重载，无需 `nodemon`。

---

## 代码改写详解

### 1. Express 服务器入口 (`server.js`)

```javascript
const express = require('express');
const { handleProxyRequest } = require('./lib/proxy');

const app = express();
const PORT = process.env.PORT || 3000;

// 解析请求体
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

// CORS 中间件
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', '31536000');
    
    if (req.method === 'OPTIONS') {
        res.header('X-Request-Type', 'CORS Preflight');
        return res.sendStatus(200);
    }
    next();
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        nodeVersion: process.version
    });
});

// 代理路由（排除健康检查）
app.all('/*', (req, res, next) => {
    if (req.path === '/health') return next();
    handleProxyRequest(req, res);
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] Proxy server running on port ${PORT}`);
    console.log(`[${new Date().toISOString()}] Node.js version: ${process.version}`);
    console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
});
```

---

### 2. 代理核心逻辑 (`lib/proxy.js`)

```javascript
/**
 * 解析请求 URL，提取目标 URL 和自定义 Headers
 * @param {string} fullUrl - 完整请求 URL
 * @returns {{ url: string, headers: object }}
 */
function parseURL(fullUrl) {
    // 移除协议和域名部分，获取路径
    const urlObj = new URL(fullUrl);
    let urlbody = decodeURIComponent(urlObj.pathname.slice(1) + urlObj.search);
    
    console.log('    Parsing: URLBody: ' + urlbody);
    
    // 查找真实 URL 和 Headers 的分界点
    const split_header_url = urlbody.lastIndexOf('/', urlbody.search('://'));
    const real_url = urlbody.substr(split_header_url + 1);
    
    if (!real_url) {
        throw new Error('Invalid real URL: ' + urlbody);
    }
    
    let headersbody = urlbody.substr(0, split_header_url);
    console.log('    Parsing: Real URL: ' + real_url);
    console.log('    Parsing: Headers JSON: ' + headersbody);
    
    if (!headersbody) {
        return { url: real_url, headers: {} };
    }
    
    if (!headersbody.startsWith('{')) {
        headersbody = decodeURIComponent(headersbody);
    }
    
    if (!headersbody.startsWith('{')) {
        throw new Error('Invalid URL headers string: ' + headersbody);
    }
    
    const headers = JSON.parse(headersbody);
    return { url: real_url, headers };
}

/**
 * 处理代理请求
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handleProxyRequest(req, res) {
    try {
        // 构建完整 URL（Express req.url 不包含协议和域名）
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        console.log('Got Raw ReqUrl: ' + fullUrl);
        
        const parsed = parseURL(fullUrl);
        let targetUrl = parsed.url;
        const customHeaders = parsed.headers;
        
        console.log('Parsed URL body: ' + targetUrl);
        console.log('Parsed URL headers: ' + JSON.stringify(customHeaders));
        
        // URL 验证
        if (targetUrl.length < 3 || targetUrl.indexOf('.') === -1) {
            throw new Error('Invalid URL input: ' + targetUrl);
        }
        
        // 特殊路径处理
        if (targetUrl === 'favicon.ico' || targetUrl === 'robots.txt') {
            return res.redirect(307, 'https://workers.cloudflare.com');
        }
        
        // 补全协议
        if (!targetUrl.toLowerCase().startsWith('http')) {
            targetUrl = 'http://' + targetUrl;
        }
        
        // 构建 fetch 选项
        const fetchOptions = {
            method: customHeaders._method?.toUpperCase() || req.method,
            headers: {}
        };
        
        // 复制请求头（排除部分特殊头）
        const excludeHeaders = ['host', 'content-length'];
        for (const [key, value] of Object.entries(req.headers)) {
            if (!excludeHeaders.includes(key.toLowerCase())) {
                fetchOptions.headers[key] = value;
            }
        }
        
        // 合并自定义 Headers
        Object.assign(fetchOptions.headers, customHeaders);
        delete fetchOptions.headers._method;
        delete fetchOptions.headers._body;
        
        // 处理请求体
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            if (customHeaders._body !== undefined) {
                fetchOptions.body = customHeaders._body;
            } else if (req.body) {
                const ct = (req.headers['content-type'] || '').toLowerCase();
                if (ct.includes('application/json')) {
                    fetchOptions.body = JSON.stringify(req.body);
                } else if (typeof req.body === 'string') {
                    fetchOptions.body = req.body;
                } else if (Buffer.isBuffer(req.body)) {
                    fetchOptions.body = req.body;
                } else {
                    fetchOptions.body = JSON.stringify(req.body);
                }
            }
        }
        
        // 发起代理请求（使用 Node.js 22+ 内置 fetch）
        const response = await fetch(targetUrl, fetchOptions);
        
        // 设置响应状态码
        res.status(response.status);
        
        // 设置响应 Content-Type
        const contentType = response.headers.get('content-type');
        if (contentType) {
            res.set('Content-Type', contentType);
        }
        
        // 获取响应体并发送
        const arrayBuffer = await response.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));
        
    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).json({
            code: -1,
            msg: err.stack || err.message || String(err)
        });
    }
}

module.exports = { parseURL, handleProxyRequest };
```

---

### 3. PM2 配置文件 (`ecosystem.config.js`)

```javascript
module.exports = {
    apps: [{
        name: 'uniproxy',
        script: 'server.js',
        instances: 'max',        // 使用所有 CPU 核心
        exec_mode: 'cluster',    // 集群模式
        env: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        error_file: './logs/error.log',
        out_file: './logs/out.log',
        merge_logs: true,
        max_memory_restart: '500M'
    }]
};
```

---

## 部署步骤

### 环境要求

```bash
# 检查 Node.js 版本（必须 >= 22.0.0）
node --version
# 输出应为 v22.x.x 或更高
```

### 开发环境测试

```bash
cd vps-deploy
npm install
npm run dev
# 访问 http://localhost:3000/health 验证服务状态
# 访问 http://localhost:3000/{target_url} 测试代理
```

### 生产环境部署

```bash
# 1. 安装依赖
cd vps-deploy && npm install --production

# 2. 使用 PM2 启动
npm install -g pm2
pm2 start ecosystem.config.js

# 3. 设置开机自启
pm2 startup
pm2 save

# 4. 查看服务状态
pm2 status
pm2 logs uniproxy
```

### Nginx 反向代理配置（可选）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket 支持
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # 超时设置
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

---

## 验证计划

### 健康检查

```bash
curl http://localhost:3000/health
# 预期返回：
# {"status":"ok","timestamp":"...","uptime":...,"nodeVersion":"v22.x.x"}
```

### 功能测试

| 测试项 | 测试方法 |
|-------|---------|
| 基本 GET 请求 | `curl http://localhost:3000/https://httpbin.org/get` |
| POST 请求 | `curl -X POST -H "Content-Type: application/json" -d '{"test":1}' http://localhost:3000/https://httpbin.org/post` |
| 自定义 Headers | `curl 'http://localhost:3000/{"X-Custom":"value"}/https://httpbin.org/headers'` |
| CORS 预检 | `curl -X OPTIONS http://localhost:3000/https://example.com` |

### 性能测试

```bash
# 使用 ab 进行压力测试
ab -n 1000 -c 100 http://localhost:3000/https://httpbin.org/get
```

---

## 新增文件清单

| 操作 | 文件路径 |
|-----|---------|
| [NEW] | [package.json](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vps-deploy/package.json) |
| [NEW] | [server.js](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vps-deploy/server.js) |
| [NEW] | [lib/proxy.js](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vps-deploy/lib/proxy.js) |
| [NEW] | [ecosystem.config.js](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vps-deploy/ecosystem.config.js) |

---

## 与原代码的差异说明

| 差异点 | 原 Workers 代码 | Express 版本 |
|-------|----------------|-------------|
| 入口方式 | `addEventListener('fetch', ...)` | `app.all('/*', ...)` |
| 请求对象 | `Request` Web API | Express `req` 对象 |
| 响应方式 | 返回 `Response` 对象 | 使用 `res.send()` |
| URL 解析 | 从 `request.url` 获取完整 URL | 需手动拼接 `req.protocol + host + originalUrl` |
| 请求体读取 | `request.json()` / `request.text()` | Express 中间件预解析到 `req.body` |
| HTTP 客户端 | Cloudflare 内置 `fetch` | Node.js 22+ 内置 `fetch` |
| 健康检查 | 无 | `/health` 端点 |
