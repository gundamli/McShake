'use strict';

/**
 * 麦摇摇 McShake - 本地服务
 *
 * 像素风老虎机：从麦当劳门店真实在售菜单取单品与图片，
 * 摇出三件餐品后给出各自的营养数据、每件单价与到手折扣。
 *
 * 零第三方依赖，仅使用 Node 22 内置的 http / fetch。
 * 启动： node server.js  （默认端口 8787）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { McpClient } = require('./src/mcp-client');
const nutrition = require('./src/nutrition');
const optimizer = require('./src/optimizer');

/** 计价结果归一化，实现见 src/optimizer.js（抽离出来以便单元测试覆盖） */
const normalizePriceResult = optimizer.normalizePriceResult;
const slot = require('./src/slot');
const storeQuery = require('./src/store-query');
const combo = require('./src/combo');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 进程内会话状态（Token 默认只驻留内存，不落盘） */
const session = {
  mcp: null,
  token: null,
  library: new nutrition.NutritionLibrary(),
  menu: [],
  menuStoreId: null,
  coupons: [],
  storeContext: {},
  slotAvailability: null,
  /** 1+1 随心配索引：{ combos, slotMap }，按门店缓存 */
  comboIndex: null,
  comboStore: null,
  templates: loadTemplates(),
  lastError: null,
};

/** 可售性预检结果的缓存时长（5 分钟），避免反复消耗 MCP 配额 */
const AVAILABILITY_TTL_MS = 5 * 60 * 1000;

function loadTemplates() {
  try {
    const p = path.join(DATA_DIR, 'tool-templates.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { /* 忽略损坏的模板文件 */ }
  return {};
}

function saveTemplates() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'tool-templates.json'), JSON.stringify(session.templates, null, 2), 'utf8');
  } catch (_) { /* 模板保存失败不影响主流程 */ }
}

// ---------------------------------------------------------------- 参数构造

/**
 * 依据 inputSchema 的字段名，用会话上下文自动填参。
 * 官方未公开参数细节，因此采用关键词启发式匹配，字段名变化时也能大概率命中。
 */
const CONTEXT_HINTS = [
  { match: /storeid|store_id|storecode|storeno|shopid|shop_id|restaurantid|门店id|门店编码|门店编号/i, key: 'storeId' },
  { match: /becode|be_code|业务编码/i, key: 'beCode' },
  { match: /addressid|address_id|useraddressid|地址id/i, key: 'addressId' },
  { match: /^lat$|latitude|纬度/i, key: 'lat' },
  { match: /^lng$|^lon$|longitude|经度/i, key: 'lng' },
  // city 必须排在 keyword 之前：下面那条 keyword 规则同样能匹配 "city" 字段，
  // 若被它先命中，city 会被填成完整的关键词（如「杭州三里亭餐厅」），
  // 而 query-nearby-stores 对 city 有城市名校验，非城市名直接返回 0 家。
  { match: /cityname|城市|^city$/i, key: 'city' },
  { match: /keyword|searchkey|address|addr|location|位置|地址|关键词/i, key: 'keyword' },
  { match: /date|日期|时间/i, key: 'date' },
  { match: /pagenum|pageindex|pageno|current|页码|当前页/i, key: 'pageNum' },
  { match: /^page$|pagesize|pagesize$|size$|^limit$|count$|rows|每页|条数/i, key: 'pageSize' },
];

/**
 * 实测得到的枚举默认值（来自 tools/list 的 schema 描述）
 *   beType:    1-到店取餐，2-麦乐送到家，5-得来速，6-企业团餐
 *   orderType: 1-到店（含到店自取+得来速），2-外送（含麦乐送+团餐）
 *   searchType:1-搜索收藏餐厅，2-按位置搜索
 * 这些字段几乎总是必填，给出合理默认值可避免每次都打断用户。
 */
const DEFAULT_ARG_VALUES = {
  beType: 1,
  orderType: 1,
  searchType: 2,
  pageNum: 1,
  pageSize: 50,
  current: 1,
  size: 50,
};

/**
 * 填充参数。返回 { args, missing }
 * missing 为无法推断的必填字段列表，交由前端生成动态表单。
 */
function fillArgs(toolName, explicit = {}) {
  const tool = session.mcp ? session.mcp.getToolSchema(toolName) : null;
  const schema = tool && tool.inputSchema ? tool.inputSchema : null;
  const props = (schema && schema.properties) || {};
  const required = Array.isArray(schema && schema.required) ? schema.required : [];

  const ctx = {
    ...session.storeContext,
    date: new Date().toISOString().slice(0, 10),
    pageNum: 1,
    pageSize: 50,
  };

  const args = { ...explicit };

  if (tool) {
    for (const [key, prop] of Object.entries(props)) {
      if (args[key] !== undefined) continue;

      // 关键约束：非必填字段不得随意套用上下文。
      // 例如 reservationDate 的说明是"预约场景必传，非预约场景不传"，
      // 若自动填入当天日期，接口会按预约场景处理并返回异常结果。
      const isRequired = required.includes(key);
      if (!isRequired) {
        const lower = key.toLowerCase();
        const hasPreset = Object.keys(DEFAULT_ARG_VALUES).some((k) => k.toLowerCase() === lower);
        const isContextField = /storecode|storeid|becode|addressid|keyword|city|latitude|longitude/i.test(key);
        if (!hasPreset && !isContextField) continue;
      }

      let filled = undefined;
      for (const hint of CONTEXT_HINTS) {
        if (hint.match.test(key) && ctx[hint.key] !== undefined && ctx[hint.key] !== null && ctx[hint.key] !== '') {
          filled = ctx[hint.key];
          break;
        }
      }
      if (filled === undefined && prop && prop.default !== undefined) filled = prop.default;
      if (filled === undefined) {
        const lower = key.toLowerCase();
        for (const [dk, dv] of Object.entries(DEFAULT_ARG_VALUES)) {
          if (dk.toLowerCase() === lower) { filled = dv; break; }
        }
      }
      if (filled === undefined && prop && Array.isArray(prop.enum) && prop.enum.length) {
        // 兜底：枚举字段取第一个合法值，避免必填校验失败
        filled = prop.enum[0];
      }
      if (filled !== undefined) args[key] = filled;
    }
  }

  const missing = required.filter((k) => args[k] === undefined || args[k] === '' || args[k] === null);

  return { args, missing, schema, tool };
}

/** 常见工具的候选参数组，用于 schema 不可用或未命中时的容错重试 */
const FALLBACK_CANDIDATES = {
  'list-nutrition-foods': [{}, { pageNum: 1, pageSize: 200 }, { pageSize: 500 }],
  'query-my-coupons': [{}, { pageNum: 1, pageSize: 50 }, { type: 0 }],
  'available-coupons': [{}, { pageNum: 1, pageSize: 50 }],
  'query-store-coupons': [{}, { pageNum: 1, pageSize: 50 }],
  'now-time-info': [{}],
  'campaign-calendar': [{}, { month: new Date().toISOString().slice(0, 7) }],
  'query-my-account': [{}],
  'query-lottery-info': [{}],
  'query-my-prizes': [{}, { pageNum: 1, pageSize: 20 }],
  'order-list': [{}, { pageNum: 1, pageSize: 20 }],
  'mall-order-list': [{}, { pageNum: 1, pageSize: 20 }],
  'delivery-query-addresses': [{}],
  'query-party-city': [{}],
};

async function callToolSmart(toolName, explicit = {}, { useTemplate = true } = {}) {
  if (!session.mcp) throw new Error('尚未连接 MCP 服务');

  // 1. 用户保存过的模板优先
  if (useTemplate && session.templates[toolName]) {
    try {
      const data = await session.mcp.callTool(toolName, session.templates[toolName]);
      return { data, args: session.templates[toolName], source: 'template' };
    } catch (err) {
      session.lastError = `模板调用失败（${toolName}）: ${err.message}`;
    }
  }

  // 2. 按 schema 推断
  const { args, missing, schema } = fillArgs(toolName, explicit);
  if (missing.length === 0 && (Object.keys(args).length > 0 || !schema)) {
    try {
      const data = await session.mcp.callTool(toolName, args);
      return { data, args, source: 'schema' };
    } catch (err) {
      session.lastError = `${toolName} 调用失败: ${err.message}`;
    }
  }

  // 3. 候选参数组重试
  const candidates = FALLBACK_CANDIDATES[toolName] || [];
  if (candidates.length) {
    try {
      const { data, usedArgs } = await session.mcp.callToolWithFallback(toolName, candidates);
      return { data, args: usedArgs, source: 'fallback' };
    } catch (err) {
      session.lastError = `${toolName} 候选参数均失败: ${err.message}`;
    }
  }

  // 4. 需要用户补充参数
  return {
    needInput: true,
    toolName,
    schema,
    args,
    missing,
    message: missing.length
      ? `工具 ${toolName} 需要补充参数：${missing.join('、')}`
      : `工具 ${toolName} 调用失败：${session.lastError || '未知错误'}`,
  };
}

// ---------------------------------------------------------------- 业务能力

async function ensureLibrary({ force = false } = {}) {
  if (session.library.size > 0 && !force) return session.library;
  const res = await callToolSmart('list-nutrition-foods', {}, { useTemplate: true });
  if (res.needInput) throw new Error(res.message);
  const count = session.library.load(res.data);
  if (count === 0) {
    throw new Error('营养库返回为空，可调用 POST /api/mcp/call 试出 list-nutrition-foods 的正确参数并保存为模板');
  }
  return session.library;
}

/**
 * 预约时段参数。
 *
 * 只在 store/select 显式传入 reservationDate 时才下发（正常使用不传）。
 * 用途：随心配按餐段供应，早餐时段菜单里没有它；演示或测试时可以指定
 * 一个午市时段，看到 1+1 的完整链路，而不必等到 10:44。
 */
function reservationArg() {
  const v = session.storeContext.reservationDate;
  return v ? { reservationDate: String(v) } : {};
}

/**
 * 加载门店菜单。
 *
 * 实测 query-meals 只返回分类与餐品编码（{categories:[{name,meals:[{code,tags}]}]}），
 * 不含名称与价格。名称必须用 query-meal-detail 按 code 逐个获取，
 * 价格则只能通过 calculate-price 试算。
 *
 * 为控制配额消耗：限制补全数量、控制并发，并把结果缓存到本地文件。
 */
async function loadMenu({ force = false, maxDetail = 400, concurrency = 6 } = {}) {
  if (session.menu.length > 0 && !force) return session.menu;

  const storeKey = session.storeContext.storeCode || session.storeContext.storeId;
  const cacheFile = storeKey
    ? path.join(DATA_DIR, `menu-cache-${String(storeKey).replace(/[^\w.-]/g, '')}.json`)
    : null;

  if (!force && cacheFile && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(cached) && cached.length) {
        session.menu = cached;
        return cached;
      }
    } catch (_) { /* 缓存损坏则重新拉取 */ }
  }

  const res = await callToolSmart('query-meals', reservationArg());
  if (res.needInput) throw new Error(res.message);

  const outer = res.data && res.data.data ? res.data.data : res.data;
  const categories = (outer && outer.categories) || [];

  const targets = [];
  const seen = new Set();
  for (const c of categories) {
    for (const m of (c.meals || [])) {
      const code = m && m.code != null ? String(m.code) : null;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      targets.push({ code, category: c.name || null });
    }
  }

  const menu = [];
  const errors = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      if (menu.length >= maxDetail) return;
      try {
        const d = await callToolSmart('query-meal-detail', { code: t.code, ...reservationArg() });
        if (d.needInput) {
          if (errors.length < 5) errors.push({ code: t.code, message: d.message, args: d.args });
          continue;
        }
        const detail = (d.data && d.data.data) ? d.data.data : d.data;
        const name = detail && (detail.name || detail.mealName || detail.productName);
        if (name) {
          menu.push({
            code: t.code,
            name: String(name),
            category: t.category ? String(t.category).replace(/\s+/g, '') : null,
            price: null,
            image: detail && typeof detail.image === 'string' ? detail.image : null,
            hasRounds: !!(detail && Array.isArray(detail.rounds) && detail.rounds.length),
          });
        } else if (errors.length < 5) errors.push({ code: t.code, message: '详情未返回名称', sample: JSON.stringify(detail || {}).slice(0, 160) });
      } catch (err) {
        if (errors.length < 5) errors.push({ code: t.code, message: err.message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  session.menuErrors = errors.slice(0, 5);
  session.menuTotalCodes = targets.length;

  session.menu = menu;
  if (cacheFile) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(menu), 'utf8');
    } catch (_) { /* 缓存写入失败不影响主流程 */ }
  }
  return menu;
}

// ---------------------------------------------------------------- 1+1 随心配

/**
 * 加载当前门店的「1+1 随心配」分区结构。
 *
 * 滚轮里不出现套餐，所以菜单阶段拿不到 rounds；这里按需为套餐编码补一次 detail。
 * 早餐时段菜单里根本没有随心配，因此返回空索引是**正常结果**，不是错误——
 * 界面据此提示「本时段没有 1+1」，而不是显示成接口失败。
 */
async function ensureComboIndex({ force = false } = {}) {
  const storeKey = String(session.storeContext.storeCode || session.storeContext.storeId || '');
  if (!storeKey) return combo.buildComboIndex([]);
  if (!force && session.comboIndex && session.comboStore === storeKey) return session.comboIndex;

  const candidates = (session.menu || [])
    .filter((m) => combo.COMBO_NAME.test(m.name || ''))
    .slice(0, 4);

  const details = [];
  for (const m of candidates) {
    try {
      const res = await callToolSmart('query-meal-detail', { code: m.code, ...reservationArg() });
      if (res.needInput) continue;
      const detail = (res.data && res.data.data) ? res.data.data : res.data;
      if (detail && Array.isArray(detail.rounds) && detail.rounds.length) {
        details.push({ code: m.code, name: detail.name || m.name, rounds: detail.rounds });
      }
    } catch (_) { /* 单个套餐拉取失败不影响其余 */ }
  }

  session.comboIndex = combo.buildComboIndex(details);
  session.comboStore = storeKey;
  return session.comboIndex;
}

/**
 * 判断摇出的这几件能不能拼成 1+1，并算出套餐实付。
 *
 * 只做「展示更低的价」这件事，不产生任何订单；套餐与单品在同一次计价里合成一单
 * 是官方支持的行为（实测 1490 + 2350 = 3840），拼单因此不需要拆成两笔。
 *
 * @param {Array<{code:string,name:string}>} items
 * @returns {Promise<Object>} 直接内嵌到 /api/slot/result 的 combo 字段
 */
async function evaluateCombo(items) {
  const index = await ensureComboIndex();
  if (!index.size) {
    return {
      available: false,
      reason: 'no_combo',
      note: '这家店当前时段没有 1+1 随心配（随心配按餐段供应，换个时段再来）',
    };
  }

  const deals = combo.findDeals(items.map((i) => i.code), index);
  if (!deals.length) {
    return {
      available: false,
      reason: 'no_pair',
      note: '这单拼不成 1+1：需要在主食区和另一区里各摇到一件',
    };
  }

  // 一次开奖最多试算两个候选组合，避免无谓消耗配额
  const priced = [];
  for (const deal of deals.slice(0, 2)) {
    try {
      const args = buildPriceArgs({
        items: [{ code: deal.comboCode, quantity: 1, roundList: deal.roundList }],
      }, null);
      const data = await session.mcp.callTool('calculate-price', args);
      const p = normalizePriceResult(data);
      if (!p || p.failed || p.payable == null) continue;
      priced.push({ deal, price: p });
    } catch (_) { /* 换下一个候选 */ }
  }

  if (!priced.length) {
    return {
      available: false,
      reason: 'price_failed',
      note: '这单理论上能拼 1+1，但套餐价试算失败（可能该组合当前不可售）',
    };
  }

  priced.sort((a, b) => a.price.payable - b.price.payable);
  const best = priced[0];

  // 单点合计只用于算「省了多少」；拿不到就不编，宁可只报套餐价
  let listTotal = 0;
  for (const s of best.deal.slots) {
    let unit = null;
    const cached = session.slotAvailability && session.slotAvailability.data
      ? session.slotAvailability.data[s.code]
      : null;
    if (cached && cached.price != null) unit = cached.price;
    if (unit == null && session.mcp) {
      try {
        const args = buildPriceArgs({ items: [{ code: s.code, quantity: 1 }] }, null);
        const data = await session.mcp.callTool('calculate-price', args);
        const p = normalizePriceResult(data);
        if (p && !p.failed && p.payable != null) unit = p.payable;
      } catch (_) { /* 忽略 */ }
    }
    if (unit == null) { listTotal = 0; break; }
    listTotal += unit;
  }

  const saving = listTotal > 0 ? Math.round((listTotal - best.price.payable) * 100) / 100 : null;
  const hasSaving = saving != null && saving > 0;

  return {
    available: true,
    code: best.deal.comboCode,
    name: best.deal.comboName,
    payable: best.price.payable,
    listTotal: listTotal > 0 ? listTotal : null,
    saving: hasSaving ? saving : null,
    discountLabel: hasSaving ? combo.discountLabel(best.price.payable, listTotal) : null,
    slots: best.deal.slots.map((s) => ({
      roundName: s.roundName,
      name: s.name,
      code: s.code,
      diffPrice: s.diffPrice,
    })),
    note: hasSaving
      ? `把这两件拼成「${best.deal.comboName}」，比单点省 ¥${saving.toFixed(2)}`
      : `把这两件拼成「${best.deal.comboName}」，实付 ¥${best.price.payable.toFixed(2)}`,
  };
}

// ---------------------------------------------------------------- HTTP 服务

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      connected: Boolean(session.mcp),
      // 前端首次加载时用它显示真实连接状态，避免还没确认就显示「已连接」
      toolCount: session.mcp && session.mcp.tools ? session.mcp.tools.length : 0,
      storeName: session.storeContext.storeName || '',
      storeCode: session.storeContext.storeCode || null,
      librarySize: session.library.size,
      menuSize: session.menu.length,
      couponSize: session.coupons.length,
      rateRemaining: session.mcp ? session.mcp.rateLimiter.remaining : null,
      // 门店是否在营业时段内（实时状态，界面上直接标出来，避免下单时才报 60003）
      storeOpen: session.storeContext.businessStatus ?? null,
      businessHours: session.storeContext.businessHours || null,
    });
  }

  if (pathname === '/api/mcp/connect' && method === 'POST') {
    const body = await readBody(req);
    const { token, endpoint } = body;
    if (!token) return sendJson(res, 400, { ok: false, error: '缺少 MCP Token' });
    try {
      const client = new McpClient({ token, endpoint: endpoint || undefined });
      await client.connect();
      const tools = await client.listTools({ force: true });
      session.mcp = client;
      session.token = token;
      return sendJson(res, 200, {
        ok: true,
        toolCount: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          required: (t.inputSchema && t.inputSchema.required) || [],
          properties: (t.inputSchema && t.inputSchema.properties) || {},
        })),
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message, code: err.code || null });
    }
  }

  if (pathname === '/api/mcp/tools' && method === 'GET') {
    if (!session.mcp) return sendJson(res, 200, { ok: false, error: '未连接' });
    const tools = session.mcp.tools || [];
    return sendJson(res, 200, {
      ok: true,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        required: (t.inputSchema && t.inputSchema.required) || [],
        properties: (t.inputSchema && t.inputSchema.properties) || {},
      })),
    });
  }

  if (pathname === '/api/mcp/call' && method === 'POST') {
    const body = await readBody(req);
    const { name, args, saveAsTemplate } = body;
    if (!session.mcp) return sendJson(res, 200, { ok: false, error: '未连接 MCP' });
    try {
      const data = await session.mcp.callTool(name, args || {});
      if (saveAsTemplate) {
        session.templates[name] = args || {};
        saveTemplates();
      }
      return sendJson(res, 200, { ok: true, data, args });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message, code: err.code || null });
    }
  }

  if (pathname === '/api/stores' && method === 'POST') {
    const body = await readBody(req);
    const input = body.keyword || body.address || '';
    session.storeContext.keyword = input;
    // 城市留空表示「重新选城市」，要把上一次的城市清掉，否则新搜索会被旧 city 带偏
    if (body.city) session.storeContext.city = body.city;
    else if (body.city === '') delete session.storeContext.city;
    if (body.lat) session.storeContext.lat = body.lat;
    if (body.lng) session.storeContext.lng = body.lng;

    try {
      if (!session.mcp) {
        return sendJson(res, 200, { ok: false, needToken: true, error: '尚未连接 MCP 服务' });
      }
      // query-nearby-stores 的实测约束：
      //   - searchType=1 是「搜索收藏餐厅」，按位置搜必须用 2（schema 默认值是 1，显式覆盖）
      //   - city 与 keyword 在 searchType=2 时都是必填，缺任一个返回 code 600058
      //   - city 必须是服务端认可的城市名/区名，塞整句进去会静默返回 0 家
      // 因此按候选组依次尝试，取第一组有结果的。
      const plans = storeQuery.buildStoreQueries(input, body.city);
      if (!plans.length) {
        return sendJson(res, 200, { ok: false, error: '请先输入城市名或地标，如「杭州 三里亭」' });
      }

      const attempts = [];
      let hit = null;

      for (const plan of plans) {
        const args = {
          beType: Number(body.beType) || 1,
          searchType: 2,
          city: plan.city,
          keyword: plan.keyword,
        };
        let data;
        try {
          data = await session.mcp.callTool('query-nearby-stores', args);
        } catch (err) {
          attempts.push({ ...plan, error: err.message });
          continue;
        }
        const arr = optimizer.extractArray(data, ['stores', 'storeList']);
        const code = data && data.code !== undefined ? data.code : null;
        attempts.push({ ...plan, count: arr.length, code });
        if (arr.length) { hit = { args, arr, plan }; break; }
      }

      if (!hit) {
        const last = attempts[attempts.length - 1] || {};
        // city 与 keyword 相同说明已经退化到「整串匹配」，此时最可能的原因就是城市没填对
        const hint = last.city && last.city === last.keyword
          ? `city 必须是城市名 / 区名，「${last.city}」未被识别，请在「城市」框里单独填上城市（如 杭州）`
          : '可换更具体的城市或地标重试（接口无分页参数，每次只返回距离最近的 5 家）';
        return sendJson(res, 200, {
          ok: false,
          error: `未找到相关门店：${hint}。最后一次尝试：city=${last.city || '-'} keyword=${last.keyword || '-'}，返回码 ${last.code ?? '无'}`,
          attempts,
        });
      }

      // 实测字段：data[].storeCode（门店编号，工具入参）、data[].beCode（业务编码）
      const stores = hit.arr.map((s) => ({
        raw: s,
        id: s.storeCode ?? s.storeId ?? s.storeNo ?? s.id ?? null,
        storeCode: s.storeCode ?? null,
        beCode: s.beCode ?? null,
        name: s.storeName ?? s.name ?? s.title ?? '未命名门店',
        address: s.address ?? s.storeAddress ?? s.addr ?? '',
        distance: s.distance ?? s.dist ?? null,
        reservation: s.reservation ?? null,
        // 营业状态与时段（用于在门店列表上直接标「营业中 / 已打烊」）
        businessStatus: s.businessStatus ?? null,
        businessStartTime: s.businessStartTime ?? null,
        businessEndTime: s.businessEndTime ?? null,
      }));

      // 记下本次真正生效的城市，后续工具调用可复用
      session.storeContext.city = hit.plan.city;
      session.storeContext.keyword = hit.plan.keyword;

      return sendJson(res, 200, { ok: true, stores, args: hit.args, attempts });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/store/select' && method === 'POST') {
    const body = await readBody(req);
    // storeId 是上下文键名，实际取值是门店编号 storeCode（外送场景还需配 beCode）
    session.storeContext.storeId = body.storeCode || body.storeId;
    session.storeContext.storeCode = body.storeCode || body.storeId;
    // 门店中文名：接口只认编号，但界面上没人想读「门店 3330052」
    session.storeContext.storeName = body.storeName || '';
    session.storeContext.storeAddress = body.storeAddress || '';
    if (body.beCode) session.storeContext.beCode = body.beCode;
    // 营业状态：接口返回 businessStatus（当前是否营业）与营业时段。
    // 打烊时 calculate-price 直接回 60003「门店暂停营业」，界面上提前标出来比下单失败友好。
    session.storeContext.businessStatus = body.businessStatus ?? null;
    session.storeContext.businessHours = body.businessStartTime
      ? `${body.businessStartTime}-${body.businessEndTime}`
      : null;
    // 预约时段（可选）：仅演示/测试用，用于在早餐时段查看午市菜单里的 1+1 随心配
    if (body.reservationDate) session.storeContext.reservationDate = String(body.reservationDate);
    else delete session.storeContext.reservationDate;
    session.menu = [];
    session.coupons = [];
    session.comboIndex = null;
    session.comboStore = null;
    session.slotAvailability = null;
    try {
      const menu = await loadMenu({ force: true });
      // 打烊门店的 query-meals 会正常返回但一条餐品都没有。
      // 若不区分，界面只会显示「菜单为空」，用户会以为是接口坏了或自己选错门店。
      if (!menu.length) {
        const closed = session.storeContext.businessStatus === false;
        return sendJson(res, 200, {
          ok: false,
          emptyMenu: true,
          storeClosed: closed,
          error: closed
            ? `门店已打烊（营业时间 ${session.storeContext.businessHours || '未知'}），当前没有在售餐品`
            : '这家门店暂时没有可取餐品，换一家试试',
          menuSize: 0,
          totalCodes: session.menuTotalCodes || 0,
          errors: session.menuErrors || [],
        });
      }
      return sendJson(res, 200, {
        ok: true,
        menuSize: menu.length,
        menu: menu.slice(0, 200),
        totalCodes: session.menuTotalCodes || 0,
        errors: session.menuErrors || [],
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  // 清除门店上下文：老虎机页面的「换门店」按钮要先清空，否则刷新后仍是原门店的菜单
  if (pathname === '/api/store/clear' && method === 'POST') {
    session.storeContext = {};
    session.menu = [];
    session.menuStoreId = null;
    session.coupons = [];
    session.slotAvailability = null;
    session.comboIndex = null;
    session.comboStore = null;
    return sendJson(res, 200, { ok: true });
  }

  // ------------------------------------------------------------ 老虎机

  if (pathname === '/api/slot/symbols' && method === 'GET') {
    try {
      if (!session.mcp) return sendJson(res, 200, { ok: false, needToken: true, error: '尚未连接 MCP 服务' });

      // 没有门店上下文时直接告知前端去选门店。
      // 早期实现靠「菜单加载失败」的错误文案里是否含「门店」来判断，而实际文案是
      // 「工具 query-meals 需要补充参数：storeCode」——不含门店二字，前端于是误判成
      // 「MCP 未就绪」并把用户弹去配置页，导致「换门店」点了没反应。
      if (!session.storeContext.storeCode && !session.storeContext.storeId) {
        return sendJson(res, 200, { ok: false, needStore: true, error: '请先选择门店' });
      }

      if (!session.menu.length) {
        try {
          await loadMenu({ force: true });
        } catch (err) {
          return sendJson(res, 200, { ok: false, error: `菜单加载失败：${err.message}` });
        }
      }
      if (!session.menu.length) {
        // needStore 让前端弹出选门店窗（而不是误判成「MCP 未连接」）
        const closed = session.storeContext.businessStatus === false;
        return sendJson(res, 200, {
          ok: false,
          needStore: true,
          storeClosed: closed,
          error: closed
            ? `已选门店「${session.storeContext.storeName || session.storeContext.storeCode || ''}」当前已打烊（营业时间 ${session.storeContext.businessHours || '未知'}），没有在售餐品`
            : '还没有选择门店，先选一家有在售餐品的门店',
        });
      }

      // 营养库决定符号挑选的优先级：优先选能算出营养的餐品
      await ensureLibrary();

      const symbols = slot.pickSymbols(session.menu, {
        // 与 nutritionFor 保持同一套判定，避免把套餐误判为「有营养」而排到前面
        hasNutrition: (m) => !!nutritionFor(m).nutrition,
      });
      if (!symbols.length) return sendJson(res, 200, { ok: false, error: '菜单中没有可用于老虎机的餐品图片' });

      // 图片本地化：下载一次后走本地路径，避免前端依赖外网、也避免每次刷新重复请求 CDN
      const withImages = await localizeImages(symbols);

      // 可售性预检：菜单里存在但当前时段买不到的商品（如已下架的限时款）会让整单计价被拒，
      // 与其在开奖后才报错，不如在装载滚轮时就标出来。
      const availability = await verifyAvailability(withImages);

      const enriched = withImages.map((s) => ({
        ...s,
        ...nutritionFor(s),
        available: availability[s.code] ? availability[s.code].available : null,
        unitPrice: availability[s.code] ? availability[s.code].price : null,
      }));

      const unavailable = enriched.filter((s) => s.available === false);

      // 1+1 索引：早餐时段没有随心配属正常情况，size=0 时界面提示「本时段没供应」
      let combo1plus1 = { size: 0, names: [] };
      try {
        const idx = await ensureComboIndex();
        combo1plus1 = { size: idx.size, names: idx.combos.map((c) => c.name) };
      } catch (_) { /* 不影响开奖 */ }

      return sendJson(res, 200, {
        ok: true,
        symbols: enriched,
        librarySize: session.library.size,
        menuSize: session.menu.length,
        combo1plus1,
        // store 保留编号字符串以兼容旧前端，新增 storeInfo 带中文名与地址
        store: session.storeContext.storeCode || null,
        storeInfo: {
          code: session.storeContext.storeCode || null,
          name: session.storeContext.storeName || '',
          address: session.storeContext.storeAddress || '',
        },
        availabilityChecked: availability.__checked === true,
        unavailableCount: unavailable.length,
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  if (pathname === '/api/slot/result' && method === 'POST') {
    const body = await readBody(req);
    const codes = Array.isArray(body.codes) ? body.codes.slice(0, 3) : [];
    if (!session.mcp) return sendJson(res, 200, { ok: false, error: '尚未连接 MCP 服务' });

    try {
      // 以菜单为准还原餐品信息，避免前端伪造名称
      const items = codes.map((code) => {
        const m = session.menu.find((x) => String(x.code) === String(code));
        if (!m) return { code: String(code), name: String(code), image: null, isCombo: false, nutrition: null, nutritionNote: '菜单中未找到该餐品' };
        const n = nutritionFor(m);
        const rel = localPathFor(m);
        const cached = fs.existsSync(path.join(SLOT_IMG_DIR, path.basename(rel)));
        return {
          code: String(code),
          name: m.name,
          // 图片为麦当劳版权素材，不随仓库分发；本地未缓存时回退到官方 CDN 原始地址
          image: cached ? rel : null,
          remoteImage: m.image || null,
          isCombo: !!m.hasRounds,
          nutrition: n.nutrition,
          nutritionNote: n.nutritionNote,
          matchedName: n.matchedName,
        };
      });

      const summary = nutrition.summarize(items.map((i) => ({
        name: i.name,
        quantity: 1,
        nutrition: i.nutrition,
      })));
      const notes = nutrition.buildHealthNotes(summary);

      // 价格试算：三个餐品一起下单，服务端会自动计算组合优惠
      let price = null;
      let priceError = null;
      let perItem = null;
      let priceArgs = null;
      try {
        const args = buildPriceArgs({ items: items.map((i) => ({ code: i.code, quantity: 1 })) }, null);
        priceArgs = args;
        const data = await session.mcp.callTool('calculate-price', args);
        price = normalizePriceResult(data);

        if (price && price.failed) {
          // 整单被拒时（常见原因：其中某个商品售罄），降级为逐件试算，
          // 这样至少能告诉用户哪几件可买、单价多少，而不是整单无价格。
          priceError = price.message;
          perItem = await priceEachItem(items);
          const okCount = perItem.filter((p) => p.price && !p.price.failed).length;
          if (okCount === items.length) {
            // 全部单件可售 → 说明是组合本身不被接受，给出单件合计作为参考价
            const sum = perItem.reduce((s, p) => s + ((p.price && p.price.payable) || 0), 0);
            price = {
              payable: Math.round(sum * 100) / 100,
              original: null,
              discount: null,
              deliveryFee: null,
              estimated: true,
              note: '组合下单被拒绝，此处为单件价格合计，不含组合优惠',
            };
          } else {
            price = null;
          }
        } else if (!price) {
          priceError = '计价接口未返回金额';
        }
      } catch (err) {
        priceError = err.message;
      }

      // 1+1 随心配：滚轮只收单品，但两件单品可能正好能拼成套餐价，出账时再算一次
      let comboDeal = null;
      try {
        comboDeal = await evaluateCombo(items);
      } catch (err) {
        comboDeal = { available: false, reason: 'error', note: `1+1 判断失败：${err.message}` };
      }

      return sendJson(res, 200, {
        ok: true,
        items: perItem ? items.map((it, idx) => ({ ...it, unitPrice: perItem[idx] ? perItem[idx].price : null })) : items,
        summary,
        notes,
        price,
        priceError,
        perItem,
        priceArgs,
        combo: comboDeal,
        storeInfo: {
          code: session.storeContext.storeCode || null,
          name: session.storeContext.storeName || '',
          address: session.storeContext.storeAddress || '',
        },
      });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: `未找到接口 ${pathname}` });
}

// ---------------------------------------------------------------- 老虎机素材

const SLOT_IMG_DIR = path.join(PUBLIC_DIR, 'img', 'slot');

/** 本地缓存路径（相对站点根目录） */
function localPathFor(meal) {
  return `/img/slot/${String(meal.code).replace(/[^\w.-]/g, '')}.png`;
}

/**
 * 为餐品取营养数据。
 *
 * 重要：组合型餐品（套餐，rounds 非空）不做名称匹配。实测发现
 * 「板烧鸡腿堡三件套」会匹配到单品「板烧鸡腿堡」，得到与单品完全相同的 391kcal，
 * 实际上套餐还含薯条和可乐——这类静默的低估比没有数据更危险，因此宁可留空并给出说明。
 */
function nutritionFor(meal) {
  if (meal.hasRounds || meal.isCombo) {
    return { nutrition: null, nutritionNote: '这是套餐，麦当劳 MCP 不提供套餐的拆分营养数据（不猜，猜出来的都是错的）' };
  }
  if (!session.library.size) return { nutrition: null, nutritionNote: null };

  const best = session.library.best(meal.name);
  if (!best || best.score < 0.55) {
    // 营养库没收录 ≈ 新品：官方营养表更新比菜单慢，这不是「没营养」
    return {
      nutrition: null,
      nutritionNote: '麦当劳 MCP 的营养库里没有它——新品还没收录，是 MCP 的锅，不是它不健康',
      matchedName: null,
      matchScore: best ? Number(best.score.toFixed(3)) : 0,
    };
  }
  const r = best.record;
  return {
    nutrition: {
      energyKcal: r.energyKcal,
      protein: r.protein,
      fat: r.fat,
      carb: r.carb,
      sodium: r.sodium,
      calcium: r.calcium,
    },
    nutritionNote: null,
    matchedName: r.name,
    matchScore: Number(best.score.toFixed(3)),
  };
}

/**
 * 把符号的远程图片下载到本地。
 * 失败不阻塞：回退到远程 URL，前端仍能正常显示（CDN 无防盗链已实测）。
 */
async function localizeImages(symbols) {
  try {
    if (!fs.existsSync(SLOT_IMG_DIR)) fs.mkdirSync(SLOT_IMG_DIR, { recursive: true });
  } catch (_) {
    return symbols.map((s) => ({ ...s, image: s.image, localImage: null }));
  }

  const tasks = symbols.map(async (s) => {
    const rel = localPathFor(s);
    const abs = path.join(SLOT_IMG_DIR, path.basename(rel));
    try {
      if (!fs.existsSync(abs) || fs.statSync(abs).size < 1024) {
        const r = await fetch(s.image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 1024) throw new Error('图片内容异常');
        fs.writeFileSync(abs, buf);
      }
      return { ...s, image: rel, remoteImage: s.image, localImage: rel };
    } catch (_) {
      return { ...s, remoteImage: s.image, localImage: null };
    }
  });

  return Promise.all(tasks);
}

/**
 * 构造 calculate-price 参数。
 *
 * 实测要点：
 *   - items 元素结构为 { productCode, quantity }（num 可省略）
 *   - 字段名写错时接口不报错，而是静默返回 price=0 且 productList 为空，
 *     因此必须严格使用 productCode，否则会得到"免费"的假结果
 *   - 优惠由服务端自动计算并体现在 discount 字段，无需（也无参数）传入券码
 */
/**
 * 逐件试算价格。
 *
 * 整单计价被拒（如其中某件售罄）时用于降级：单独为每件商品调用 calculate-price，
 * 这样可以定位到底是哪一件不可售，并给出其余商品的单价。
 * 串行执行以避免短时间打满 600 次/分钟的限流额度。
 *
 * @param {Array<{code:string,name:string}>} items
 * @returns {Promise<Array<{code:string,name:string,price:object|null,error:string|null}>>}
 */
async function priceEachItem(items) {
  const out = [];
  for (const it of items) {
    try {
      const args = buildPriceArgs({ items: [{ code: it.code, quantity: 1 }] }, null);
      const data = await session.mcp.callTool('calculate-price', args);
      const price = normalizePriceResult(data);
      if (price && price.failed) {
        out.push({ code: it.code, name: it.name, price: null, error: price.message });
      } else {
        out.push({ code: it.code, name: it.name, price, error: price ? null : '未返回金额' });
      }
    } catch (err) {
      out.push({ code: it.code, name: it.name, price: null, error: err.message });
    }
  }
  return out;
}

/**
 * 批量校验符号的可售性并取单价。
 *
 * 菜单会随时间变化（时段菜单、限时款下架），菜单里存在的商品未必当下能下单。
 * 这里并行试算一次，结果缓存 5 分钟，避免每次装载滚轮都消耗 MCP 配额。
 *
 * @param {Array<{code:string,name:string}>} symbols
 * @returns {Promise<Object>} { [code]: {available:boolean, price:number|null, reason?:string} }
 */
async function verifyAvailability(symbols) {
  const out = {};
  if (!session.mcp || !symbols.length) return out;

  const storeKey = String(session.storeContext.storeCode || session.storeContext.storeId || '');
  const now = Date.now();
  const cache = session.slotAvailability;
  const cacheValid = cache && cache.store === storeKey && (now - cache.at) < AVAILABILITY_TTL_MS;

  // 并行发起，但受限于 MCP 的 600 次/分钟配额，符号数量很小（约 13 个）故无需分批处理
  await Promise.all(symbols.map(async (s) => {
    const code = String(s.code);
    if (cacheValid && cache.data[code]) {
      out[code] = cache.data[code];
      return;
    }
    try {
      const args = buildPriceArgs({ items: [{ code, quantity: 1 }] }, null);
      const data = await session.mcp.callTool('calculate-price', args);
      const price = normalizePriceResult(data);
      if (price && price.failed) {
        out[code] = { available: false, price: null, reason: price.message };
      } else if (price && price.payable != null) {
        out[code] = { available: true, price: price.payable };
      } else {
        out[code] = { available: null, price: null, reason: '未返回金额' };
      }
    } catch (err) {
      out[code] = { available: null, price: null, reason: err.message };
    }
  }));

  // 只有真正发起了查询才刷新缓存，避免用不完整结果覆盖
  if (!cacheValid) {
    session.slotAvailability = { store: storeKey, at: now, data: out };
  }
  out.__checked = !cacheValid;
  return out;
}

function buildPriceArgs(plan, template) {
  if (template) {
    const json = JSON.stringify(template)
      .replace(/"\{\{items\}\}"/g, JSON.stringify(plan.items));
    return JSON.parse(json);
  }

  const ctx = session.storeContext;
  const items = plan.items
    .filter((i) => i.code)
    .map((i) => {
      const item = { productCode: String(i.code), quantity: Number(i.quantity) || 1 };
      // 套餐必须带 roundList，告诉服务端每个分区选了哪件子品；
      // 只传套餐码会得到 60006「商品已售罄或不可售」（实测）。
      if (Array.isArray(i.roundList) && i.roundList.length) item.roundList = i.roundList;
      return item;
    });

  // orderType / beType 为必填，缺省按「到店自取」处理
  const base = {
    orderType: Number(ctx.orderType) || 1,
    beType: Number(ctx.beType) || 1,
  };
  if (ctx.storeCode || ctx.storeId) base.storeCode = String(ctx.storeCode || ctx.storeId);
  if (ctx.beCode) base.beCode = ctx.beCode;
  // 预约时段：仅调试/演示时由 store/select 显式传入，正常使用不传
  if (ctx.reservationDate) base.reservationDate = ctx.reservationDate;

  return { ...base, items };
}


function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  // 站点只有老虎机一个页面，根路径直接落到它（旧的「营养与凑单分析」页已移除）
  if (pathname === '/' || pathname === '') pathname = '/slot.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  serveStatic(req, res, url);
});

/**
 * 若环境变量提供了 Token，启动时自动连接，免去每次重启后手工填写。
 * 用法：MCD_MCP_TOKEN=xxx node server.js
 */
async function autoConnect() {
  const token = process.env.MCD_MCP_TOKEN;
  if (!token) return;
  try {
    const client = new McpClient({ token });
    await client.connect();
    await client.listTools({ force: true });
    session.mcp = client;
    console.log('  已使用环境变量 MCD_MCP_TOKEN 自动连接 MCP 服务');
  } catch (err) {
    console.log(`  自动连接失败：${err.message}`);
  }
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  麦摇摇 McShake · 麦当劳营养账本与凑单优化器');
  console.log(`  访问 http://${HOST}:${PORT}`);
  console.log('');
  console.log('  打开页面后填入麦当劳 MCP Token（或在下方用环境变量自动连接）。');
  console.log('  提示：MCP Token 仅在本次进程内存中保存，不会写入磁盘。');
  console.log('  也可通过环境变量自动连接：MCD_MCP_TOKEN=xxx node server.js');
  console.log('');
  autoConnect();
});
