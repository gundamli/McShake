'use strict';

/**
 * 演示模式的数据源：用快照伪装成一个 MCP 客户端。
 *
 * 为什么这么做：
 *   公网试玩不能内置任何人的 MCP Token。把一场真实会话（菜单、营养库、逐件单价、
 *   286 种三连组合的真实计价结果、1+1 套餐价）抓成快照后，用同样的
 *   `callTool(name, args)` 接口重放，服务端业务逻辑一行都不用改——菜单、营养匹配、
 *   折扣分摊、1+1 拼单全部照旧跑，只是数据来自快照而不是实时接口。
 *
 * 边界：
 *   - 金额一律「分」，与官方接口一致；
 *   - 三连组合直接返回抓取时的真实响应（含真实优惠与分摊）；
 *   - 快照里没有的组合（例如访问者自己填 Token 前不会出现）按真实单价合成，
 *     绝不编造折扣；
 *   - 其他工具直接抛错，由上层降级提示，而不是返回假数据。
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'demo', 'demo-snapshot.json');

/**
 * 取餐方式是平台的固定枚举（实测 calculate-price 的 data.takeWayList），
 * 与门店、时段无关，所以快照没抓到也不影响演示——下单弹窗要靠它列选项。
 */
const TAKE_WAY = [
  { code: 'eat-in', title: '堂食' },
  { code: 'take-in-store', title: '外带' },
];

/** 读快照；不存在则返回 null（服务端据此决定是否启用演示模式） */
function loadSnapshot(file = SNAPSHOT_PATH) {
  try {
    if (!fs.existsSync(file)) return null;
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!snap || !Array.isArray(snap.menu) || !snap.menu.length) return null;
    return snap;
  } catch (_) {
    return null;
  }
}

class DemoMcpClient {
  constructor(snapshot) {
    this.snapshot = snapshot;
    this.isDemo = true;
    this.prices = snapshot.prices || {};
    this.priceTable = snapshot.triples || {};
    this.menuByCode = new Map((snapshot.menu || []).map((m) => [String(m.code), m]));
    this.comboByCode = new Map((snapshot.combos || []).map((c) => [String(c.code), c]));
    this.rateLimiter = { remaining: null };
    this.token = null;
    this.tools = Object.entries(snapshot.schemas || {}).map(([name, inputSchema]) => ({
      name,
      inputSchema: inputSchema || {},
    }));
  }

  async connect() {
    return { serverInfo: { name: 'McShake Demo Snapshot', version: String(this.snapshot.version || 1) } };
  }

  async listTools() {
    return this.tools;
  }

  getToolSchema(name) {
    return this.tools.find((t) => t.name === name) || null;
  }

  async callToolWithFallback(name, candidates = []) {
    const errors = [];
    for (const args of candidates) {
      try {
        return { data: await this.callTool(name, args), usedArgs: args };
      } catch (err) {
        errors.push({ args, message: err.message });
      }
    }
    throw new Error(`工具 ${name} 调用失败: ${errors.map((e) => e.message).join(' | ')}`);
  }

  /** 演示模式下固定用快照里的符号集，保证与已抓取的三连价格表一一对应 */
  symbolsOverride(menu) {
    const byCode = new Map((menu || []).map((m) => [String(m.code), m]));
    return (this.snapshot.symbols || [])
      .map((s) => {
        const m = byCode.get(String(s.code));
        if (!m) return null;
        return {
          id: s.code,
          code: s.code,
          name: m.name,
          image: m.image,
          category: s.category,
          categoryLabel: s.categoryLabel,
          accent: s.accent,
          rare: !!s.rare,
          isCombo: false,
          menuCategory: m.category || s.menuCategory || null,
        };
      })
      .filter(Boolean);
  }

  async callTool(name, args = {}) {
    switch (name) {
      case 'list-nutrition-foods':
        return this.snapshot.nutrition;
      case 'query-meals':
        return this.queryMeals();
      case 'query-meal-detail':
        return this.mealDetail(args.code);
      case 'calculate-price':
        return this.calculatePrice(args);
      case 'query-nearby-stores':
        return this.nearbyStores(args);
      default:
        throw new Error(`演示模式不提供工具 ${name}（填入自己的 MCP Token 后可用）`);
    }
  }

  queryMeals() {
    // 快照里保存的是扁平菜单，这里还原成 {categories:[{name, meals:[{code}]}]}
    const order = [];
    const groups = new Map();
    for (const m of this.snapshot.menu) {
      const cat = m.category || '其他';
      if (!groups.has(cat)) { groups.set(cat, []); order.push(cat); }
      groups.get(cat).push({ code: String(m.code), tags: [] });
    }
    return {
      success: true,
      code: 0,
      data: { categories: order.map((cat) => ({ name: cat, meals: groups.get(cat) })) },
    };
  }

  mealDetail(code) {
    const key = String(code);
    const combo = this.comboByCode.get(key);
    if (combo) {
      return {
        success: true,
        code: 0,
        data: {
          code: key,
          name: combo.name,
          image: (this.menuByCode.get(key) || {}).image || null,
          rounds: combo.rounds.map((r) => ({
            id: r.id,
            name: r.name,
            quantity: r.quantity,
            maxQuantity: r.quantity,
            choices: r.choices.map((c) => ({ code: c.code, name: c.name, diffPrice: c.diffPrice })),
          })),
        },
      };
    }
    const m = this.menuByCode.get(key);
    if (!m) return { success: false, code: 404, message: `快照中没有餐品 ${key}` };
    return { success: true, code: 0, data: { code: key, name: m.name, image: m.image } };
  }

  /** 单件真实单价（分） */
  unitPrice(code) {
    const p = this.prices[String(code)];
    if (!p || p.failed) return null;
    return p.price != null ? p.price : null;
  }

  /** 套餐价 = 基础价 + 各分区所选子件的差价（已用真实响应验算过） */
  comboPrice(combo, roundList) {
    let diffFen = 0;
    let original = 0;
    const names = [];
    for (const rl of roundList) {
      const round = (combo.rounds || []).find((r) => String(r.id) === String(rl.round));
      const picked = (rl.comboItemList || [])[0];
      if (!round || !picked) continue;
      const choice = round.choices.find((c) => String(c.code) === String(picked.code));
      if (!choice) return null;
      diffFen += Number(choice.diffFen) || 0;
      names.push(choice.name);
      const unit = this.unitPrice(choice.code);
      if (unit != null) original += unit;
    }
    const payable = combo.baseFen + diffFen;
    return { payable, original: original > 0 ? original : payable, names };
  }

  calculatePrice(args = {}) {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) return { success: false, code: 400, message: 'items 为空' };

    const hasRound = items.some((i) => Array.isArray(i.roundList) && i.roundList.length);

    // 1) 纯单品（每件数量合计不超过 3）：直接命中抓取时的真实响应
    if (!hasRound) {
      const expanded = [];
      for (const it of items) {
        const q = Math.max(1, Number(it.quantity) || 1);
        for (let i = 0; i < q; i += 1) expanded.push(String(it.productCode));
      }
      if (expanded.length <= 3) {
        const key = expanded.slice().sort().join('|');
        const hit = this.priceTable[key];
        if (hit && !hit.failed) {
          return {
            success: true,
            code: 0,
            data: Object.assign({ takeWayList: TAKE_WAY }, hit),
          };
        }
        // 组合本身在抓取时失败（上游 508 等），退化为逐件合成，不编折扣
      }
    }

    const lines = [];
    let original = 0;
    let payable = 0;

    for (const it of items) {
      const code = String(it.productCode || '');
      const quantity = Math.max(1, Number(it.quantity) || 1);

      if (Array.isArray(it.roundList) && it.roundList.length) {
        const cb = this.comboByCode.get(code);
        if (!cb) return { success: false, code: 404, message: `快照中没有套餐 ${code}` };
        const priced = this.comboPrice(cb, it.roundList);
        if (!priced) return { success: false, code: 400, message: `套餐 ${cb.name} 的子件不在快照中` };
        const name = `${cb.name}（${priced.names.join(' + ')}）`;
        lines.push({
          productCode: code,
          productName: name,
          quantity,
          originalSubtotal: priced.original * quantity,
          subtotal: priced.payable * quantity,
        });
        original += priced.original * quantity;
        payable += priced.payable * quantity;
        continue;
      }

      const unit = this.unitPrice(code);
      if (unit == null) {
        return { success: false, code: 404, message: `快照中没有 ${code} 的价格（演示模式仅覆盖已抓取的餐品）` };
      }
      const m = this.menuByCode.get(code);
      lines.push({
        productCode: code,
        productName: (m && m.name) || code,
        quantity,
        originalSubtotal: unit * quantity,
        subtotal: unit * quantity,
      });
      original += unit * quantity;
      payable += unit * quantity;
    }

    return {
      success: true,
      code: 0,
      data: {
        originalPrice: original,
        price: payable,
        discount: Math.max(0, original - payable),
        productList: lines,
        takeWayList: TAKE_WAY,
      },
    };
  }

  /**
   * 演示模式只有快照里这一家门店。搜索词跟它对不上就返回空数组，
   * 交给上层提示「演示模式搜不到其他城市」——
   * 若无视搜索词一律返回上海店，用户搜「北京」却看到上海的店，只会当成搜索坏了。
   */
  nearbyStores(args = {}) {
    const s = this.snapshot.store || {};
    const city = String(args.city || '').trim();
    const keyword = String(args.keyword || '').trim();
    const hay = [s.storeName, s.storeAddress, s.city].filter(Boolean).join(' ');
    // 城市允许双向包含：「上海」能匹配「上海市」，反之亦然
    const cityOk = !city || hay.includes(city) || (!!s.city && (s.city.includes(city) || city.includes(s.city)));
    const keywordOk = !keyword || hay.includes(keyword);
    if (!cityOk || !keywordOk) {
      return { success: true, code: 0, data: [] };
    }
    return {
      success: true,
      code: 0,
      data: [{
        storeCode: s.storeCode || null,
        storeName: s.storeName || '演示门店',
        storeAddress: s.storeAddress || '',
        cityName: s.city || null,
        beCode: null,
        businessStatus: s.businessStatus ?? true,
        businessStartTime: s.businessStartTime || null,
        businessEndTime: s.businessEndTime || null,
      }],
    };
  }
}

module.exports = { DemoMcpClient, loadSnapshot, SNAPSHOT_PATH };
