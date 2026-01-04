# Vercel 部署方案：Cloudflare Workers 迁移至 Vercel Edge Functions

将现有的 Cloudflare Workers 代理服务迁移至 Vercel Edge Functions，实现全球边缘节点部署。

> [!TIP]
> Edge Functions 的 API 与 Cloudflare Workers 高度相似，代码改动极小。

---

## 方案概述

### 为什么选择 Edge Functions

| 特性 | Cloudflare Workers | Vercel Edge Functions |
|------|-------------------|----------------------|
| 运行时 | V8 Isolates | V8 Isolates |
| `fetch` API | ✅ 支持 | ✅ 支持 |
| `Request`/`Response` | ✅ 支持 | ✅ 支持 |
| 全球边缘部署 | ✅ | ✅ |
| 冷启动 | 无 | 无 |

两者 API 几乎一致，迁移成本极低。

---

## 目录结构

```
cloudflare-workers-uniproxy/
├── index.js                    # 原 Cloudflare Workers 代码（保留）
├── VPS_DEPLOY_GUIDE.md         # VPS 部署方案
├── VERCEL_DEPLOY_GUIDE.md      # 本文档
├── vercel-deploy/              # Vercel 部署目录（新增）
│   ├── api/
│   │   └── [[...path]].js      # 通配符路由（Edge Function）
│   ├── vercel.json             # Vercel 配置
│   └── package.json            # 项目配置
└── README.md
```

---

## 代码改写详解

### 1. Edge Function 入口 (`api/[[...path]].js`)

```javascript
// 使用 Edge Runtime
export const config = {
    runtime: 'edge',
};

/**
 * 解析请求 URL，提取目标 URL 和自定义 Headers
 */
function parseURL(url) {
    const urlObj = new URL(url);
    let urlbody = decodeURIComponent(urlObj.pathname.slice(1) + urlObj.search);
    
    console.log('    Parsing: URLBody: ' + urlbody);
    
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
 * 处理所有 HTTP 方法
 */
export default async function handler(request) {
    // CORS 预检处理
    if (request.method === 'OPTIONS') {
        return new Response('', {
            status: 200,
            headers: {
                'Access-Control-Allow-Credentials': 'true',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Max-Age': '31536000',
                'X-Request-Type': 'CORS Preflight'
            }
        });
    }

    // 健康检查
    const url = new URL(request.url);
    if (url.pathname === '/health' || url.pathname === '/api/health') {
        return new Response(JSON.stringify({
            status: 'ok',
            timestamp: new Date().toISOString(),
            runtime: 'edge'
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    let outBody, outStatus = 200, outCt = null;
    const outHeaders = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*'
    });

    try {
        console.log('Got Raw ReqUrl: ' + request.url);
        
        const parsed = parseURL(request.url);
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
            return Response.redirect('https://vercel.com', 307);
        }

        // 补全协议
        if (!targetUrl.toLowerCase().startsWith('http')) {
            targetUrl = 'http://' + targetUrl;
        }

        // 构建 fetch 选项
        const fetchOptions = {
            method: request.method,
            headers: {}
        };

        // 复制请求头
        const reqHeaders = request.headers;
        for (const [key, value] of reqHeaders.entries()) {
            if (!['content-length', 'host'].includes(key.toLowerCase())) {
                fetchOptions.headers[key] = value;
            }
        }

        // 处理自定义方法
        if (customHeaders._method !== undefined) {
            fetchOptions.method = customHeaders._method.toUpperCase();
        }
        
        // 合并自定义 Headers
        Object.assign(fetchOptions.headers, customHeaders);
        delete fetchOptions.headers._method;
        delete fetchOptions.headers._body;

        // 处理请求体
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
            const ct = (reqHeaders.get('content-type') || '').toLowerCase();
            
            if (customHeaders._body !== undefined) {
                fetchOptions.body = customHeaders._body;
            } else if (ct.includes('application/json')) {
                fetchOptions.body = JSON.stringify(await request.json());
            } else if (ct.includes('application/text') || ct.includes('text/html')) {
                fetchOptions.body = await request.text();
            } else if (ct.includes('form')) {
                fetchOptions.body = await request.formData();
            } else {
                fetchOptions.body = await request.blob();
            }
            
            // 确保 Content-Type 被转发
            if (ct) {
                fetchOptions.headers['content-type'] = reqHeaders.get('content-type');
            }
        }

        // 发起代理请求
        const response = await fetch(targetUrl, fetchOptions);
        outStatus = response.status;
        outCt = response.headers.get('content-type');
        outBody = response.body;

    } catch (err) {
        outStatus = 500;
        outCt = 'application/json';
        outBody = JSON.stringify({
            code: -1,
            msg: err.stack || err.message || String(err)
        });
    }

    if (outCt) {
        outHeaders.set('content-type', outCt);
    }

    return new Response(outBody, {
        status: outStatus,
        headers: outHeaders
    });
}
```

---

### 2. Vercel 配置 (`vercel.json`)

```json
{
    "version": 2,
    "rewrites": [
        {
            "source": "/(.*)",
            "destination": "/api/$1"
        }
    ],
    "headers": [
        {
            "source": "/(.*)",
            "headers": [
                { "key": "Access-Control-Allow-Origin", "value": "*" },
                { "key": "Access-Control-Allow-Methods", "value": "GET, POST, PUT, PATCH, DELETE, OPTIONS" }
            ]
        }
    ]
}
```

---

### 3. 项目配置 (`package.json`)

```json
{
    "name": "uniproxy-vercel",
    "version": "1.0.0",
    "description": "CORS Proxy for Vercel Edge deployment",
    "private": true
}
```

> [!NOTE]
> Edge Functions 无需额外依赖，`fetch`、`Request`、`Response` 等 API 均为内置。

---

## 部署步骤

### 方式一：通过 Vercel CLI

```bash
# 1. 安装 Vercel CLI
npm install -g vercel

# 2. 进入部署目录
cd vercel-deploy

# 3. 登录并部署
vercel login
vercel

# 4. 部署到生产环境
vercel --prod
```

### 方式二：通过 GitHub 集成

1. 将代码推送到 GitHub 仓库
2. 在 [vercel.com](https://vercel.com) 导入项目
3. 设置 **Root Directory** 为 `vercel-deploy`
4. 点击 **Deploy**

---

## 验证计划

### 健康检查

```bash
curl https://your-project.vercel.app/health
# 预期返回：
# {"status":"ok","timestamp":"...","runtime":"edge"}
```

### 功能测试

| 测试项 | 测试方法 |
|-------|---------|
| 基本 GET 请求 | `curl https://your-project.vercel.app/https://httpbin.org/get` |
| POST 请求 | `curl -X POST -H "Content-Type: application/json" -d '{"test":1}' https://your-project.vercel.app/https://httpbin.org/post` |
| 自定义 Headers | `curl 'https://your-project.vercel.app/{"X-Custom":"value"}/https://httpbin.org/headers'` |
| CORS 预检 | `curl -X OPTIONS https://your-project.vercel.app/https://example.com` |

---

## 新增文件清单

| 操作 | 文件路径 |
|-----|---------|
| [NEW] | [api/[[...path]].js](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vercel-deploy/api/[[...path]].js) |
| [NEW] | [vercel.json](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vercel-deploy/vercel.json) |
| [NEW] | [package.json](file:///Users/elegance/Documents/GitHub/cloudflare-workers-uniproxy/vercel-deploy/package.json) |

---

## 与原 Workers 代码的差异

| 差异点 | Cloudflare Workers | Vercel Edge Functions |
|-------|-------------------|----------------------|
| 入口方式 | `addEventListener('fetch', ...)` | `export default function handler(request)` |
| 配置文件 | `wrangler.toml` | `vercel.json` |
| 路由处理 | 自动 | 需要配置 rewrites |
| 日志查看 | Cloudflare Dashboard | Vercel Dashboard |
| 其他 API | 完全一致 | 完全一致 |

---

## 限制说明

| 限制项 | 免费版 | Pro 版 |
|-------|--------|--------|
| 执行时间 | 30 秒 | 30 秒 |
| 内存 | 128 MB | 128 MB |
| 代码大小 | 1 MB | 4 MB |
| 每月调用次数 | 100,000 | 1,000,000 |

> [!WARNING]
> 如果代理目标服务器响应较慢，可能会触发执行时间限制。
