# cloudflare-workers-uniproxy

基于 Cloudflare Workers 的通用代理，支持 GET、POST、PUT、PATCH、DELETE 等 HTTP 请求，并内置域名白名单功能。

## 功能特性

- ✅ 支持所有 HTTP 方法（GET、POST、PUT、PATCH、DELETE）
- ✅ 自定义请求头和请求体
- ✅ 域名白名单保护
- ✅ 支持通配符域名匹配
- ✅ CORS 跨域支持
- ✅ 自动处理多种 Content-Type

## 快速开始

### 1. 部署到 Cloudflare Workers

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**
3. 点击 **Create Application** → **Create Worker**
4. 将 `index.js` 的内容复制到编辑器中
5. 点击 **Save and Deploy**

### 2. 配置白名单（推荐）

在 `index.js` 文件顶部修改 `ALLOWED_TARGET_DOMAINS` 数组：

```javascript
const ALLOWED_TARGET_DOMAINS = [
    'api.example.com',      // 精确匹配
    '*.cdn.example.com',    // 通配符匹配所有子域名
    'mysite.com',
];
```

**白名单规则：**
- **精确匹配**：`example.com` 只匹配 `example.com`
- **通配符匹配**：`*.example.com` 匹配 `sub.example.com`、`api.example.com` 等
- **空数组**：`[]` 表示不限制（允许所有域名，**不推荐用于生产环境**）

如果请求的目标域名不在白名单中，将返回 `403` 错误。

## 使用方法

假设您的 Worker 地址为 `https://uniproxy.yourname.workers.dev`

### 1. 简单 GET 请求

```
https://uniproxy.yourname.workers.dev/https://api.example.com/data
```

### 2. 传递自定义 Headers

```
https://uniproxy.yourname.workers.dev/{"Authorization":"Bearer token123"}/https://api.example.com/user
```

支持 JSON 格式的 headers：

```javascript
{
    "Authorization": "Bearer token123",
    "X-Custom-Header": "value"
}
```

### 3. 使用 POST 方法 + Body

```
https://uniproxy.yourname.workers.dev/{"_method":"POST","_body":"helloworld"}/https://api.example.com/submit
```

**特殊参数：**
- `_method`: 指定 HTTP 方法（POST、PUT、PATCH、DELETE）
- `_body`: 请求体内容

### 4. POST 请求 + Headers + Body

```
https://uniproxy.yourname.workers.dev/{"_method":"POST","_body":"{\"name\":\"test\"}","Content-Type":"application/json"}/https://api.example.com/create
```

## 请求示例

### 示例 1: GET 请求带 Authorization

```bash
curl "https://uniproxy.yourname.workers.dev/{%22Authorization%22:%22Bearer%20YOUR_TOKEN%22}/https://api.github.com/user"
```

### 示例 2: POST JSON 数据

使用 URL 编码：

```
https://uniproxy.yourname.workers.dev/%7B%22_method%22%3A%22POST%22%2C%22_body%22%3A%22%7B%5C%22email%5C%22%3A%5C%22test%40example.com%5C%22%7D%22%2C%22Content-Type%22%3A%22application%2Fjson%22%7D/https://api.example.com/register
```

### 示例 3: 直接 POST（客户端设置 body）

从客户端发送 POST 请求：

```javascript
fetch('https://uniproxy.yourname.workers.dev/https://api.example.com/data', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({ key: 'value' })
});
```

## 安全建议

- ✅ **启用白名单**：强烈建议在 `ALLOWED_TARGET_DOMAINS` 中配置允许的域名
- ✅ **定期审查**：定期检查白名单配置，移除不再需要的域名
- ⚠️ **避免公开**：不要将 Worker URL 公开分享到不可信的地方
- ⚠️ **监控使用量**：在 Cloudflare Dashboard 中监控 Worker 的请求量

## 常见问题

### Q: 如何添加多个域名到白名单？

在数组中添加多个条目：

```javascript
const ALLOWED_TARGET_DOMAINS = [
    'api.service1.com',
    'api.service2.com',
    '*.cdn.example.com',
];
```

### Q: 通配符 `*` 如何工作？

`*.example.com` 会匹配：
- ✅ `sub.example.com`
- ✅ `api.example.com`
- ✅ `example.com`（也会匹配根域名）

但不会匹配：
- ❌ `notexample.com`
- ❌ `example.org`

### Q: 如果目标域名不在白名单会怎样？

返回 `403 Forbidden` 错误：

```json
{
    "code": 403,
    "msg": "Access denied: domain 'unauthorized.com' is not in the allowed list"
}
```

### Q: 如何禁用白名单？

将数组设置为空：

```javascript
const ALLOWED_TARGET_DOMAINS = [];
```

⚠️ **警告**：这将允许代理任意域名，可能被滥用。

## 技术规格

- **平台**: Cloudflare Workers
- **运行时**: V8 JavaScript Engine
- **支持的 HTTP 方法**: GET, POST, PUT, PATCH, DELETE, OPTIONS
- **Content-Type 支持**: JSON, FormData, Text, Binary
- **免费配额**: 100,000 请求/天（Cloudflare 免费计划）

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！
