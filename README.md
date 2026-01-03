# cloudflare-workers-uniproxy
基于 Cloudflare Workers 的通用代理，仅支持纯 GET 请求。

## 使用方法

1. 简单的 HTTP GET 请求：
  ```
    https://uniproxy.misty.workers.dev/https://hookb.in/NOPV9r1YXlUe8mNN8ryq
  ```
  
2. 传递 Header：
  ```
    https://uniproxy.misty.workers.dev/{"hello":"world"}/https://hookb.in/NOPV9r1YXlUe8mNN8ryq
  ```

3. 传递 Body：
  ```
    https://uniproxy.misty.workers.dev/{"_method":"POST","_body":"helloworld"}/https://hookb.in/NOPV9r1YXlUe8mNN8ryq
  ```
  
前往 https://hookbin.com/NOPV9r1YXlUe8mNN8ryq 查看结果 ;)
