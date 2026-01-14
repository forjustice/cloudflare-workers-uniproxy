// ==================== 白名单配置 ====================
// 在此处添加允许代理访问的目标域名
// 支持通配符: *.example.com 匹配所有子域名
// 留空数组 [] 表示不限制（允许所有域名）
const ALLOWED_TARGET_DOMAINS = [
    'example.com',
    'api.example.com',
    '*.mydomain.com',
];
// ====================================================

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

/**
 * 检查域名是否在白名单中
 * @param {string} hostname - 要检查的域名
 * @returns {boolean} - 是否允许访问
 */
function isAllowedDomain(hostname) {
    // 如果白名单为空，允许所有域名
    if (ALLOWED_TARGET_DOMAINS.length === 0) {
        return true;
    }

    hostname = hostname.toLowerCase();

    for (const pattern of ALLOWED_TARGET_DOMAINS) {
        const lowerPattern = pattern.toLowerCase();

        // 通配符匹配: *.example.com
        if (lowerPattern.startsWith('*.')) {
            const suffix = lowerPattern.slice(1); // .example.com
            if (hostname.endsWith(suffix) || hostname === lowerPattern.slice(2)) {
                return true;
            }
        }
        // 精确匹配
        else if (hostname === lowerPattern) {
            return true;
        }
    }

    return false;
}

/**
 * 从 URL 中提取域名
 * @param {string} url - 完整的 URL
 * @returns {string} - 域名
 */
function extractHostname(url) {
    try {
        return new URL(url).hostname;
    } catch {
        // 如果 URL 没有协议，尝试添加后再解析
        try {
            return new URL('http://' + url).hostname;
        } catch {
            return '';
        }
    }
}

function parseURL(url) {
    let urlbody = url.substr(8);
    urlbody = decodeURIComponent(urlbody.substr(urlbody.indexOf('/') + 1))
    console.log("    Parsing: URLBody: " + urlbody)
    let split_header_url = urlbody.lastIndexOf("/", urlbody.search("://"))
    let real_url = urlbody.substr(split_header_url + 1)
    if (!real_url) {
        throw "Invalid real URL: " + urlbody
    }
    let headersbody = urlbody.substr(0, split_header_url)
    console.log("    Parsing: Real URL: " + real_url)
    console.log("    Parsing: Headers JSON: " + headersbody)
    if (!headersbody) {
        return {
            url: real_url,
            headers: {},
        }
    }
    if (!headersbody.startsWith("{")) {
        headersbody = decodeURIComponent(headersbody)
    }

    if (!headersbody.startsWith("{")) {
        throw "Invalid URL headers string: " + headersbody
    }

    headers = JSON.parse(headersbody)

    return {
        url: real_url,
        headers: headers,
    }
}

async function handleRequest(request) {
    if (request.method == "OPTIONS") {
        return new Response("", {
            status: 200, headers: {
                "Access-Control-Allow-Credentials": true,
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Allow-Methods": "*",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Max-Age": "31536000",
                "X-Request-Type": "CORS Preflight"
            }
        });
    }

    let reqHeaders = new Headers(request.headers),
        outBody, outStatus = 200, outCt = null, fr = null, outHeaders = new Headers({
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": reqHeaders.get('Access-Control-Allow-Headers') || "Accept, Authorization, Cache-Control, Content-Type, DNT, If-Modified-Since, Keep-Alive, Origin, User-Agent, X-Requested-With, Token, x-access-token"
        });

    try {
        console.log("Got Raw ReqUrl: " + request.url)
        let t = parseURL(request.url)
        let url = t.url
        let headers = t.headers
        console.log("Parsed URL body: " + url)
        console.log("Parsed URL headers: " + JSON.stringify(headers))

        if (url.length < 3 || url.indexOf('.') == -1) {
            throw "invalid URL input: " + url;
        } else if (url == "favicon.ico" || url == "robots.txt") {
            return Response.redirect('https://workers.cloudflare.com', 307)
        } else {
            if (url.toLowerCase().indexOf("http") == -1) {
                url = "http://" + url;
            }

            // 白名单检查
            const targetHostname = extractHostname(url);
            if (!isAllowedDomain(targetHostname)) {
                return new Response(JSON.stringify({
                    code: 403,
                    msg: "Access denied: domain '" + targetHostname + "' is not in the allowed list"
                }), {
                    status: 403,
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            }

            let fp = {
                method: request.method,
                headers: {}
            }

            let he = reqHeaders.entries();
            for (let h of he) {
                if (!['content-length', 'content-type'].includes(h[0])) {
                    fp.headers[h[0]] = h[1];
                }
            }

            if (headers["_method"] !== undefined) {
                fp.method = headers["_method"].toUpperCase()
            }
            fp.headers = Object.assign({}, fp.headers, headers)

            if (["POST", "PUT", "PATCH", "DELETE"].indexOf(request.method) >= 0) {
                const ct = (reqHeaders.get('content-type') || "").toLowerCase();
                // 确保 Content-Type 被转发到目标服务器
                if (ct) {
                    fp.headers['content-type'] = reqHeaders.get('content-type');
                }
                if (ct.includes('application/json')) {
                    fp.body = JSON.stringify(await request.json());
                } else if (ct.includes('application/text') || ct.includes('text/html')) {
                    fp.body = await request.text();
                } else if (ct.includes('application/x-www-form-urlencoded')) {
                    // 保持 application/x-www-form-urlencoded 格式，不要转换为 FormData
                    // FormData 会被自动转换为 multipart/form-data，导致后端无法解析
                    fp.body = await request.text();
                } else if (ct.includes('multipart/form-data')) {
                    // 只有 multipart/form-data 才使用 formData()
                    fp.body = await request.formData();
                } else {
                    fp.body = await request.blob();
                }
            }
            if (headers["_body"] !== undefined) {
                fp.body = headers["_body"]
            }

            fr = (await fetch(url, fp));
            outStatus = fr.status;
            outCt = fr.headers.get('content-type');
            outBody = fr.body;
        }
    } catch (err) {
        console.error("Proxy error:", err.stack || err);
        outStatus = 500
        outCt = "application/json";
        // 不在响应中暴露堆栈信息，仅记录到日志
        outBody = JSON.stringify({
            code: -1,
            msg: err.message || "Internal proxy error"
        });
    }

    if (outCt && outCt != "") {
        outHeaders.set("content-type", outCt);
    }

    // 转发订阅相关的响应头（用于 Clash 显示流量和到期信息）
    if (fr) {
        const subscriptionHeaders = [
            'subscription-userinfo',
            'Subscription-Userinfo',
            'profile-update-interval',
            'Profile-Update-Interval',
            'profile-title',
            'Profile-Title',
            'content-disposition',
            'Content-Disposition'
        ];

        for (const headerName of subscriptionHeaders) {
            const headerValue = fr.headers.get(headerName);
            if (headerValue) {
                outHeaders.set(headerName.toLowerCase(), headerValue);
                console.log("Forwarding header: " + headerName + " = " + headerValue);
            }
        }
    }

    return new Response(outBody, {
        status: outStatus,
        headers: outHeaders
    })
}
