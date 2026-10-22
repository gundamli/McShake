/** 极简 HTTP 封装：只用 Node 18+ 自带的 fetch，不引任何依赖 */
const DEFAULT_TIMEOUT = 30000;

async function request(base, pathname, options = {}) {
  const { method = 'GET', body, timeout = DEFAULT_TIMEOUT } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(base + pathname, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = { ok: false, error: `服务返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}` };
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** 健康检查专用：超时要短，端口探测不能卡住整条命令 */
async function probe(base, timeout = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(base + '/api/health', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return json;
  } catch (_) {
    return null;
  }
}

module.exports = { request, probe };
