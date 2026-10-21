'use strict';

/**
 * 生成线上试玩用的演示快照（demo/demo-snapshot.json）。
 *
 * 为什么需要它：
 *   公网试玩不可能内置任何人的 MCP Token（会泄漏、会被刷配额、也违反个人非商业用途条款）。
 *   所以把一场真实会话的数据抓下来做快照：门店菜单、餐品图片、营养库、
 *   每件单品的真实价格、全部 286 种三连组合的真实计价结果、1+1 随心配的分区与套餐价。
 *   演示模式用快照重放，前端零 Token 也能完整玩；访问者仍可填自己的 Token 切到实时。
 *
 * 用法：
 *   MCD_MCP_TOKEN=xxx node scripts/build-demo-snapshot.js
 *   DEMO_STORE=1450034 DEMO_RESV="2026-10-21 12:00" node scripts/build-demo-snapshot.js
 */

const fs = require('fs');
const path = require('path');

const { McpClient } = require('../src/mcp-client');
const nutrition = require('../src/nutrition');
const optimizer = require('../src/optimizer');
const slot = require('../src/slot');
const combo = require('../src/combo');

const STORE = process.env.DEMO_STORE || '1450034';
const RESV = process.env.DEMO_RESV || '2026-10-21 12:00';
const OUT = path.join(__dirname, '..', 'demo', 'demo-snapshot.json');

const base = { storeCode: STORE, orderType: 1, beType: 1, reservationDate: RESV };

const mcp = new McpClient({ token: process.env.MCD_MCP_TOKEN });

function layer(res) {
  return res && res.data && typeof res.data === 'object' ? res.data : res;
}

function unwrap(payload) {
  // 业务数据在 {success,code,message,data:{...}} 的 data 层
  if (payload && payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

async function pool(items, limit, worker, label) {
  let cursor = 0;
  let done = 0;
  const total = items.length;
  const run = async () => {
    while (cursor < total) {
      const idx = cursor++;
      await worker(items[idx], idx);
      done += 1;
      if (label && done % 25 === 0) process.stdout.write(`  ${label} ${done}/${total}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, total) }, run));
}

/** 逐件计价，返回 data 层原样（金额单位：分） */
async function priceOne(code) {
  const raw = await mcp.callTool('calculate-price', {
    ...base,
    items: [{ productCode: String(code), quantity: 1 }],
  });
  const data = unwrap(raw);
  const norm = optimizer.normalizePriceResult(raw);
  if (norm && norm.failed) return { failed: true, code: norm.code, message: norm.message };
  if (!data || data.price == null) return { failed: true, message: '返回缺少 price 字段' };
  return data;
}

/** 三件一起计价（同码合并成 quantity），返回 data 层原样 */
async function priceTriple(codes) {
  const counter = new Map();
  for (const c of codes) counter.set(c, (counter.get(c) || 0) + 1);
  const items = [...counter.entries()].map(([productCode, quantity]) => ({ productCode, quantity }));
  const raw = await mcp.callTool('calculate-price', { ...base, items });
  const data = unwrap(raw);
  const norm = optimizer.normalizePriceResult(raw);
  if (norm && norm.failed) return { failed: true, code: norm.code, message: norm.message };
  if (!data || data.price == null) return { failed: true, message: '返回缺少 price 字段' };
  return data;
}

/** 用 roundList 走套餐价 */
async function priceCombo(comboCode, pairs) {
  const roundList = pairs.map((p) => ({
    round: String(p.roundId),
    comboItemList: [{ code: String(p.code), quantity: 1 }],
  }));
  const raw = await mcp.callTool('calculate-price', {
    ...base,
    items: [{ productCode: String(comboCode), quantity: 1, roundList }],
  });
  const data = unwrap(raw);
  const norm = optimizer.normalizePriceResult(raw);
  if (norm && norm.failed) return { failed: true, code: norm.code, message: norm.message };
  if (!data || data.price == null) return { failed: true, message: '返回缺少 price 字段' };
  return data;
}

async function main() {
  if (!process.env.MCD_MCP_TOKEN) {
    console.error('需要 MCD_MCP_TOKEN 环境变量');
    process.exit(1);
  }

  console.log('连接 MCP ...');
  await mcp.connect();
  const tools = await mcp.listTools({ force: true });
  console.log(`工具 ${tools.length} 个`);

  // 1. 菜单（名称与图片只能逐个 detail 拿）
  console.log('拉取门店菜单 ...');
  const mealsRes = await mcp.callTool('query-meals', { ...base });
  const cats = (unwrap(mealsRes) || {}).categories || [];
  const targets = [];
  const seen = new Set();
  for (const c of cats) {
    for (const m of c.meals || []) {
      const code = m && m.code != null ? String(m.code) : null;
      if (!code || seen.has(code)) continue;
      seen.add(code);
      targets.push({ code, category: c.name || null });
    }
  }
  console.log(`  菜单编码 ${targets.length} 个，逐个取详情 ...`);

  const menu = [];
  await pool(targets, 6, async (t) => {
    try {
      const res = await mcp.callTool('query-meal-detail', { ...base, code: t.code });
      const d = unwrap(res) || {};
      const name = d.name || d.mealName || d.productName;
      if (!name) return;
      menu.push({
        code: t.code,
        name: String(name),
        category: t.category ? String(t.category).replace(/\s+/g, '') : null,
        image: typeof d.image === 'string' ? d.image : null,
        hasRounds: Array.isArray(d.rounds) && d.rounds.length > 0,
      });
    } catch (_) { /* 单件失败跳过 */ }
  }, '详情');
  console.log(`  可用餐品 ${menu.length} 个`);

  // 2. 营养库（原样保存，前端/服务端解析逻辑不变）
  console.log('拉取营养库 ...');
  const libRaw = await mcp.callTool('list-nutrition-foods', {});
  const lib = new nutrition.NutritionLibrary();
  const libCount = lib.load(libRaw);
  console.log(`  营养库 ${libCount} 条`);

  // 3. 符号集（必须与服务端算法一致）
  const symbols = slot.pickSymbols(menu, {
    hasNutrition: (m) => {
      const best = lib.best(m.name);
      return !!best && best.score >= 0.55;
    },
  });
  console.log(`  滚轮符号 ${symbols.length} 个`);
  if (symbols.length < 6) throw new Error('符号不足，快照不可用');

  // 4. 1+1 随心配：分区、套餐价基准
  console.log('解析 1+1 随心配 ...');
  const comboCandidates = menu.filter((m) => combo.COMBO_NAME.test(m.name || '')).slice(0, 4);
  const combos = [];
  const choiceCodes = new Set();
  for (const m of comboCandidates) {
    try {
      const res = await mcp.callTool('query-meal-detail', { ...base, code: m.code });
      const d = unwrap(res) || {};
      const rounds = combo.normalizeRounds(d.rounds);
      if (rounds.length < 2) continue;

      // 基准价：各分区取第一个子件试算，再扣掉差价得到「基础价」
      const pair = rounds.map((r) => ({ roundId: r.id, code: r.choices[0].code, diff: r.choices[0].diffPrice }));
      const p0 = await priceCombo(m.code, pair);
      if (p0.failed) { console.log(`  ${m.name} 套餐价试算失败：${p0.message}`); continue; }
      const diffSum = pair.reduce((s, p) => s + p.diff, 0);
      const baseFen = p0.price - Math.round(diffSum * 100);

      // 抽两对别的子件验算「基础价 + 差价」是否成立
      let ok = 0;
      let bad = 0;
      const samples = [];
      for (let i = 0; i < 2; i += 1) {
        const pickPair = rounds.map((r) => {
          const c = r.choices[Math.min(r.choices.length - 1, 1 + i)];
          return { roundId: r.id, code: c.code, diff: c.diffPrice, name: c.name };
        });
        if (pickPair.some((p) => p.code === pair.find((q) => q.roundId === p.roundId).code)) continue;
        const actual = await priceCombo(m.code, pickPair);
        if (actual.failed) continue;
        const expect = baseFen + Math.round(pickPair.reduce((s, p) => s + p.diff, 0) * 100);
        const match = Math.abs(actual.price - expect) <= 1;
        if (match) ok += 1; else bad += 1;
        samples.push({
          items: pickPair.map((p) => p.name).join(' + '),
          actualFen: actual.price,
          expectFen: expect,
          match,
        });
      }

      for (const r of rounds) for (const c of r.choices) choiceCodes.add(c.code);
      combos.push({
        code: m.code,
        name: String(d.name || m.name),
        baseFen,
        rounds: rounds.map((r) => ({
          id: r.id,
          name: r.name,
          quantity: r.quantity,
          choices: r.choices.map((c) => ({
            code: c.code,
            name: c.name,
            diffPrice: c.diffPrice,
            diffFen: Math.round(c.diffPrice * 100),
          })),
        })),
        verified: { ok, bad, samples },
      });
      console.log(`  ${m.name}：基础价 ¥${(baseFen / 100).toFixed(2)}，验算 ${ok} 对成立 / ${bad} 对不符`);
    } catch (err) {
      console.log(`  ${m.name} 解析失败：${err.message}`);
    }
  }

  // 5. 单价：符号集 + 套餐子件（算「省了多少」要用）
  const singleCodes = [...new Set([...symbols.map((s) => s.code), ...choiceCodes])];
  console.log(`逐件取真实单价 ${singleCodes.length} 个 ...`);
  const prices = {};
  await pool(singleCodes, 4, async (code) => {
    try {
      prices[code] = await priceOne(code);
    } catch (err) {
      prices[code] = { failed: true, message: err.message };
    }
  }, '单价');

  // 6. 三连组合全量（11 个符号 → C(13,3)=286 种，含重复）
  const codes = symbols.map((s) => s.code);
  const triples = [];
  for (let i = 0; i < codes.length; i += 1) {
    for (let j = i; j < codes.length; j += 1) {
      for (let k = j; k < codes.length; k += 1) {
        triples.push([codes[i], codes[j], codes[k]]);
      }
    }
  }
  console.log(`三连组合计价 ${triples.length} 组 ...`);
  const priceTable = {};
  let failCount = 0;
  await pool(triples, 4, async (t) => {
    const key = t.join('|');
    try {
      const r = await priceTriple(t);
      priceTable[key] = r;
      if (r.failed) failCount += 1;
    } catch (err) {
      priceTable[key] = { failed: true, message: err.message };
      failCount += 1;
    }
  }, '组合');
  console.log(`  计价成功 ${triples.length - failCount}，失败 ${failCount}`);

  // 6.1 失败重试：并发打太密会被上游回 508「太火爆了」，改成串行小步重试
  if (failCount > 0) {
    const retryKeys = Object.entries(priceTable).filter(([, v]) => v.failed).map(([k]) => k);
    console.log(`  串行重试 ${retryKeys.length} 组 ...`);
    let fixed = 0;
    for (const key of retryKeys) {
      const codesInKey = key.split('|');
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const r = await priceTriple(codesInKey);
          if (!r.failed) { priceTable[key] = r; fixed += 1; break; }
        } catch (_) { /* 继续重试 */ }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    failCount -= fixed;
    console.log(`  重试补回 ${fixed} 组，剩余失败 ${failCount}`);
  }

  // 7. 门店信息
  let store = { storeCode: STORE, storeName: process.env.DEMO_STORE_NAME || '麦当劳门店', storeAddress: null, city: null };
  try {
    // searchType=2 才是「按位置搜索」，1 是搜收藏门店（实测返回空）
    const near = await mcp.callTool('query-nearby-stores', {
      city: '上海', keyword: process.env.DEMO_STORE_KEYWORD || '徐家汇', beType: 1, searchType: 2,
    });
    const list = unwrap(near) || {};
    const arr = Array.isArray(list.data) ? list.data : (Array.isArray(list) ? list : []);
    const hit = arr.find((s) => String(s.storeCode) === String(STORE)) || arr[0];
    if (hit) {
      store = {
        storeCode: STORE,
        storeName: hit.storeName || store.storeName,
        storeAddress: hit.storeAddress || hit.address || null,
        city: hit.cityName || '上海',
        businessStatus: hit.businessStatus ?? null,
        businessStartTime: hit.businessStartTime || null,
        businessEndTime: hit.businessEndTime || null,
      };
    }
  } catch (_) { /* 用兜底名称 */ }

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    reservationDate: RESV,
    store,
    toolNames: tools.map((t) => t.name),
    schemas: Object.fromEntries(tools.map((t) => [t.name, t.inputSchema || {}])),
    menu,
    symbols: symbols.map((s) => ({
      code: s.code, name: s.name, image: s.image,
      category: s.category, categoryLabel: s.categoryLabel, accent: s.accent,
      rare: !!s.rare, menuCategory: s.menuCategory,
    })),
    nutrition: libRaw,
    nutritionCount: libCount,
    prices,
    triples: priceTable,
    combos,
    meta: {
      symbolCount: symbols.length,
      tripleCount: triples.length,
      tripleFailed: failCount,
      note: '全部金额单位：分。菜单/营养/单价/组合价均取自麦当劳官方 MCP 真实响应，仅时点为快照。',
    },
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snapshot), 'utf8');
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`\n已写入 ${OUT}（${kb} KB）`);
  console.log(`门店：${store.storeName}（${store.storeCode}）｜符号 ${symbols.length}｜组合 ${triples.length}｜1+1 ${combos.length} 套`);
}

main().catch((err) => {
  console.error('生成失败：', err.message);
  process.exit(1);
});
