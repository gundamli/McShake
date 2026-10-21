'use strict';

/**
 * 麦当劳中国 MCP 客户端（Streamable HTTP 传输）
 *
 * 协议要点：
 *   1. 所有请求为 POST JSON-RPC 2.0，端点 https://mcp.mcd.cn
 *   2. 鉴权头 Authorization: Bearer <MCP_TOKEN>
 *   3. initialize 响应可能返回 Mcp-Session-Id，后续请求必须回传
 *   4. 响应体可能是 application/json，也可能是 text/event-stream（SSE），两种都要能解析
 *   5. 限流：每个 Token 每分钟最多 600 次请求，超限返回 429
 */

const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';
const PROTOCOL_VERSION = '2025-06-18';
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;

class RateLimiter {
  constructor(limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  async acquire() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) {
      const waitMs = this.windowMs - (now - this.hits[0]) + 30;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.acquire();
    }
    this.hits.push(now);
  }

  get remaining() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    return this.limit - this.hits.length;
  }
}

/**
 * 解析 MCP 响应体。
 * SSE 场景下服务端会推送若干 event，取最后一个携带 result / error 的消息。
 */
function parseBody(text, contentType = '') {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  if (contentType.includes('text/event-stream') || trimmed.startsWith('event:') || trimmed.includes('\ndata:')) {
    let last = null;
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const msg = JSON.parse(payload);
        if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg;
      } catch (_) {
        /* 忽略非 JSON 心跳行 */
      }
    }
    return last;
  }

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return { error: { code: -32700, message: `响应体不是合法 JSON: ${trimmed.slice(0, 200)}` } };
  }
}

/**
 * 解析麦当劳自有的表格序列化格式。
 *
 * 实测 list-nutrition-foods 的 data 字段并非 JSON，而是如下紧凑格式：
 *   [160]{productName,nutritionDescription,energyKj,energyKcal,protein,...}:
 *     猪柳麦满分,null,1288,308,16,16,24,781,213
 *     巨无霸,null,2146,513,27,26,42,961,171
 *
 * 结构：[记录数]{列名,列名,...}: 之后每行一条记录，字段以逗号分隔，null 表示空值。
 * 该格式对大列表（营养库 160 条）能显著压缩体积，但必须先转换才能被程序消费。
 */
function parseTableFormat(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = s.match(/^\[(\d+)\]\s*\{([^}]*)\}\s*:([\s\S]*)$/);
  if (!m) return null;

  const cols = m[2].split(',').map((c) => c.trim()).filter(Boolean);
  if (!cols.length) return null;

  const rows = [];
  for (const line of m[3].split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let vals = t.split(',').map((v) => v.trim());
    // 名称字段可能自带逗号，导致列数超出；将多余部分归并回首列
    if (vals.length > cols.length) {
      const extra = vals.length - cols.length;
      const head = vals.slice(0, extra + 1).join(',');
      vals = [head, ...vals.slice(extra + 1)];
    }
    const obj = {};
    cols.forEach((c, i) => {
      const v = vals[i] === undefined ? '' : vals[i];
      if (v === '' || v === 'null' || v === 'NULL') { obj[c] = null; return; }
      if (/^-?\d+(\.\d+)?$/.test(v)) { obj[c] = Number(v); return; }
      obj[c] = v;
    });
    rows.push(obj);
  }
  return rows;
}

/** 递归遍历对象，把表格格式的字符串字段就地替换为对象数组 */
function inflateTables(node, depth = 0) {
  if (depth > 6 || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === 'string') {
        const parsed = parseTableFormat(node[i]);
        if (parsed) node[i] = parsed;
      } else {
        inflateTables(node[i], depth + 1);
      }
    }
    return node;
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      const parsed = parseTableFormat(v);
      if (parsed) { node[k] = parsed; continue; }
    }
    if (v && typeof v === 'object') inflateTables(v, depth + 1);
  }
  return node;
}

/**
 * tools/call 的返回结构是 content 数组，真正的业务数据通常是 content[0].text 里的 JSON 字符串。
 * 这里统一尝试反序列化，并展开其中的表格格式字段，失败则原样返回文本。
 */
function extractPayload(result) {
  if (!result || typeof result !== 'object') return result;
  if (!Array.isArray(result.content)) return result;

  const texts = result.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);

  if (texts.length === 0) return result;

  const joined = texts.join('\n');
  let payload = null;
  try {
    payload = JSON.parse(joined);
  } catch (_) {
    payload = extractJsonBalanced(joined);
  }

  if (payload === null) return { _text: joined, structuredContent: result.structuredContent };
  // 展开嵌套的表格序列化字段（如营养库的 data）
  return inflateTables(payload);
}

/**
 * 从混合文本中稳健提取 JSON。
 *
 * 实测多个工具的 content 是「说明文字 + JSON + 说明文字」的混合体，例如：
 *   每个门店的基本信息按单行展示：
 *   - **门店名称**: data[].storeName
 *   {"success":true,"data":[...]}
 *   ## 展示结果时，每个门店的 storeCode 必须完整展示
 *
 * 这类文本不能用「首个 { 或 [ 到最后一个 } 」的朴素截取 —— 说明文字里的
 * data[] 会让起始位置错位。这里改为逐个候选起点做括号平衡扫描，
 * 并正确处理字符串字面量内的括号。
 */
function extractJsonBalanced(text) {
  const objStarts = [];
  const arrStarts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') objStarts.push(i);
    else if (ch === '[') arrStarts.push(i);
  }

  const tryAt = (start) => {
    const end = scanBalanced(text, start);
    if (end < 0) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  };

  // 先找形如业务响应的对象。说明文字中常出现 data[].storeName 这类片段，
  // 若优先匹配 '[' 会误命中空数组，因此必须先扫 '{'。
  let fallbackObj = null;
  for (const start of objStarts) {
    const v = tryAt(start);
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if ('success' in v || 'code' in v || 'data' in v || 'message' in v) return v;
    if (!fallbackObj) fallbackObj = v;
  }
  if (fallbackObj) return fallbackObj;

  for (const start of arrStarts) {
    const v = tryAt(start);
    if (v) return v;
  }
  return null;
}

/** 从 start 处做括号平衡扫描，返回匹配的闭合括号下标，失败返回 -1 */
function scanBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

class McpClient {
  constructor({ token, endpoint = DEFAULT_ENDPOINT } = {}) {
    if (!token) throw new Error('缺少 MCP Token');
    this.token = token;
    this.endpoint = endpoint;
    this.sessionId = null;
    this.tools = null;
    this.toolsFetchedAt = 0;
    this.rateLimiter = new RateLimiter();
    this.nextId = 1;
  }

  get toolNames() {
    return (this.tools || []).map((t) => t.name);
  }

  async _post(payload, { isNotification = false } = {}) {
    await this.rateLimiter.acquire();

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${this.token}`,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new Error(`网络请求失败: ${err.message}`);
    }

    // initialize 的响应头里带回会话 ID
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (res.status === 401) {
      throw Object.assign(new Error('MCP Token 无效、已过期或未提供（401）'), { code: 401 });
    }
    if (res.status === 429) {
      throw Object.assign(new Error('触发限流，每分钟最多 600 次请求（429）'), { code: 429 });
    }
    if (res.status === 404 && !this.sessionId) {
      throw Object.assign(new Error('会话不存在或已失效（404），请重新初始化连接'), { code: 404 });
    }

    const text = await res.text();
    const contentType = res.headers.get('content-type') || '';

    if (!res.ok && !text) {
      throw Object.assign(new Error(`MCP 服务返回 HTTP ${res.status}`), { code: res.status });
    }

    if (isNotification) {
      return { ok: res.ok || res.status === 202 };
    }

    const msg = parseBody(text, contentType);
    if (!msg) return { ok: true, status: res.status };

    if (msg.error) {
      const e = new Error(msg.error.message || `MCP 错误 ${msg.error.code}`);
      e.mcpCode = msg.error.code;
      throw e;
    }
    return msg.result !== undefined ? msg.result : msg;
  }

  async connect() {
    const result = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'mcshake', version: '1.0.0' },
      },
    });

    await this._post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { isNotification: true }
    ).catch(() => ({}));

    return result;
  }

  async listTools({ force = false, maxAgeMs = 10 * 60 * 1000 } = {}) {
    const fresh = this.tools && Date.now() - this.toolsFetchedAt < maxAgeMs;
    if (fresh && !force) return this.tools;

    const result = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    });

    const tools = (result && result.tools) || [];
    this.tools = tools;
    this.toolsFetchedAt = Date.now();
    return tools;
  }

  getToolSchema(name) {
    return (this.tools || []).find((t) => t.name === name) || null;
  }

  /**
   * 调用工具。返回已反序列化的业务数据。
   */
  async callTool(name, args = {}, { raw = false } = {}) {
    const result = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    return raw ? result : extractPayload(result);
  }

  /**
   * 容错调用：依次尝试多组候选参数，返回第一个成功的。
   * 用于应对官方未公开参数 schema 的情况。
   */
  async callToolWithFallback(name, candidates = [], { raw = false } = {}) {
    const errors = [];
    for (const args of candidates) {
      try {
        const data = await this.callTool(name, args, { raw });
        return { data, usedArgs: args };
      } catch (err) {
        errors.push({ args, message: err.message });
        if (err.code === 401) break;
      }
    }
    throw Object.assign(new Error(`工具 ${name} 调用失败: ${errors.map((e) => e.message).join(' | ')}`), {
      attempts: errors,
    });
  }
}

module.exports = {
  McpClient,
  RateLimiter,
  parseBody,
  extractPayload,
  parseTableFormat,
  extractJsonBalanced,
  DEFAULT_ENDPOINT,
};
