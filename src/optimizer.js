'use strict';

/**
 * 凑单优化引擎
 *
 * 思路：
 *   1. 汇总可使用的优惠券，识别每张券的门槛与面额
 *   2. 构造候选方案：基准方案、单券方案、加购凑单方案
 *   3. 由调用方对每个方案调用 calculate-price 试算真实金额
 *   4. 按「最省 / 最健康 / 均衡」三种模式排序
 *
 * 引擎本身不直接发起 MCP 调用，价格试算通过 priceFn 注入，
 * 这样在官方参数 schema 未公开的情况下，参数构造逻辑可以独立演进。
 */

const COUPON_ALIASES = {
  code: ['couponId', 'couponCode', 'couponNo', 'id', 'code', '券码', '优惠券编码', '优惠券ID'],
  name: ['couponName', 'name', 'title', '券名称', '优惠券名称', '活动名称'],
  threshold: ['threshold', 'thresholdAmount', 'minAmount', 'minSpend', 'minConsume', 'useThreshold', '门槛', '满额', '使用门槛', '最低消费'],
  discount: ['discount', 'discountAmount', 'amount', 'value', 'faceValue', '优惠金额', '减免', '面值', '抵扣'],
  expiry: ['expireTime', 'expiryTime', 'endTime', 'validTo', 'validEnd', '有效期', '过期时间', '失效时间'],
  desc: ['desc', 'description', 'ruleDesc', '说明', '规则说明', '使用说明'],
};

const MEAL_ALIASES = {
  code: ['mealCode', 'code', 'productCode', 'sku', 'id', '餐品编码', '商品编码'],
  name: ['mealName', 'name', 'title', 'productName', '餐品名称', '名称', '商品名称'],
  price: ['price', 'salePrice', 'amount', 'originPrice', '价格', '单价', '售价'],
  category: ['category', 'categoryName', 'tag', '分类', '类别'],
};

function pick(record, aliases) {
  for (const key of aliases) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]/g, '');
  const wanted = new Set(aliases.map(norm));
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    if (wanted.has(norm(k))) return v;
  }
  return null;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function normalizeCoupon(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = pick(raw, COUPON_ALIASES.name);
  const code = pick(raw, COUPON_ALIASES.code);
  if (!name && !code) return null;

  let threshold = num(pick(raw, COUPON_ALIASES.threshold));
  let discount = num(pick(raw, COUPON_ALIASES.discount));

  // 门槛常写在文案里，如"满30减5"、"满 25.9 元可用"
  const text = [name, pick(raw, COUPON_ALIASES.desc), pick(raw, COUPON_ALIASES.threshold)]
    .filter(Boolean)
    .map(String)
    .join(' ');
  if (threshold === null) {
    const m = text.match(/满\s*(\d+(?:\.\d+)?)/);
    if (m) threshold = parseFloat(m[1]);
  }
  if (discount === null) {
    const m = text.match(/减\s*(\d+(?:\.\d+)?)/);
    if (m) discount = parseFloat(m[1]);
  }

  return {
    raw,
    code: code ? String(code) : null,
    name: String(name || code || '未命名优惠券'),
    threshold,
    discount,
    expiry: pick(raw, COUPON_ALIASES.expiry) ? String(pick(raw, COUPON_ALIASES.expiry)) : null,
    desc: pick(raw, COUPON_ALIASES.desc) ? String(pick(raw, COUPON_ALIASES.desc)) : null,
  };
}

function normalizeMeal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = pick(raw, MEAL_ALIASES.name);
  const code = pick(raw, MEAL_ALIASES.code);
  if (!name && !code) return null;
  return {
    raw,
    code: code ? String(code) : null,
    name: String(name || code || '未命名餐品'),
    price: num(pick(raw, MEAL_ALIASES.price)),
    category: pick(raw, MEAL_ALIASES.category) ? String(pick(raw, MEAL_ALIASES.category)) : null,
  };
}

function extractArray(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const key of ['list', 'data', 'items', 'records', 'result', 'results', 'coupons', 'meals', 'products']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  for (const v of Object.values(payload)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
}

/**
 * 构造候选方案
 *
 * @param {Object} opts
 * @param {Array}  opts.items      已确认的餐品 [{code,name,quantity,price}]
 * @param {Array}  opts.coupons    归一化后的优惠券
 * @param {Array}  opts.menu       菜单（用于加购凑单）
 * @param {Number} opts.maxAddon   最多考虑几个加购品
 * @param {Number} opts.maxPlans   方案总数上限（控制 calculate-price 调用次数）
 */
/** 从菜单中挑选适合凑单的加购品：优先小食、饮品、甜品等低价品类 */
function pickAddons(menu, max) {
  const ADDON_HINTS = /小食|饮品|饮料|甜品|冰|饮|派|薯条|鸡块|玉米|冰淇淋|新地|圆筒/;
  const preferred = menu.filter((m) => ADDON_HINTS.test(`${m.name}${m.category || ''}`));
  const rest = menu.filter((m) => !ADDON_HINTS.test(`${m.name}${m.category || ''}`));
  return [...preferred, ...rest].slice(0, max);
}

/**
 * 构造候选方案
 *
 * 实测约束：麦当劳菜单接口不返回单品价格，优惠也由 calculate-price 服务端
 * 自动计算（无券码入参）。因此凑单不再基于"券门槛"推导，而是直接试算
 * 不同组合的真实应付金额——加购后触发的组合优惠可能使总价反而下降。
 *
 * @param {Array} opts.items   已确认餐品 [{code,name,quantity}]
 * @param {Array} opts.menu    菜单（用于挑选加购品）
 * @param {Array} opts.coupons 优惠券（当前仅用于展示与提示）
 */
function buildPlans({ items = [], coupons = [], menu = [], maxAddon = 8, maxPlans = 12 } = {}) {
  const baseItems = items.map((i) => ({ ...i }));

  const plans = [];
  const push = (plan) => {
    if (plans.length < maxPlans) plans.push({ id: `plan-${plans.length + 1}`, ...plan });
  };

  push({
    label: '基准方案（当前餐品）',
    items: baseItems,
    couponCodes: [],
    strategy: 'baseline',
    reason: '按当前识别出的餐品直接下单，作为比价基准。',
  });

  const addons = pickAddons(menu, maxAddon);
  for (const a of addons) {
    if (plans.length >= maxPlans) break;
    push({
      label: `加购「${a.name}」`,
      items: [...baseItems, { code: a.code, name: a.name, quantity: 1, isAddon: true }],
      couponCodes: [],
      addon: a,
      strategy: 'topup',
      reason: `在当前组合基础上加购该商品，由服务端计算组合后的实际应付金额。若优惠幅度足够，加购的增量成本可能远低于其原价，甚至出现总价下降。`,
    });
  }

  return plans;
}

/**
 * 对方案排序
 * @param {Array} plans 已试算（含 priceResult）的方案
 * @param {'cheapest'|'healthiest'|'balanced'} mode
 */
function rankPlans(plans, mode = 'cheapest', { priceTolerance = 0.15 } = {}) {
  const priced = plans.filter((p) => p.price && typeof p.price.payable === 'number');
  const unpriced = plans.filter((p) => !(p.price && typeof p.price.payable === 'number'));

  if (priced.length === 0) return plans;

  const cheapest = Math.min(...priced.map((p) => p.price.payable));

  for (const p of priced) {
    p.savingsVsBaseline = null;
    p.priceGap = p.price.payable - cheapest;
  }

  const baseline = priced.find((p) => p.strategy === 'baseline');
  if (baseline) {
    for (const p of priced) {
      p.savingsVsBaseline = Math.round((baseline.price.payable - p.price.payable) * 100) / 100;
    }
  }

  let sorted;
  if (mode === 'healthiest') {
    // 在接近最低价的方案里，优先热量更低、蛋白质更高的
    const pool = priced.filter((p) => p.priceGap <= Math.max(priceTolerance * cheapest, 3));
    const candidates = pool.length ? pool : priced;
    sorted = [...candidates].sort((a, b) => {
      const av = (a.nutrition?.energyKcal ?? Infinity) - (a.nutrition?.protein ?? 0) * 20;
      const bv = (b.nutrition?.energyKcal ?? Infinity) - (b.nutrition?.protein ?? 0) * 20;
      return av - bv;
    });
    sorted = [...sorted, ...priced.filter((p) => !sorted.includes(p))];
  } else if (mode === 'balanced') {
    // 综合分：价格越低越好，每克蛋白质价格越低越好，热量适中
    sorted = [...priced].sort((a, b) => score(a) - score(b));
  } else {
    sorted = [...priced].sort((a, b) => a.price.payable - b.price.payable);
  }

  return [...sorted, ...unpriced];
}

function score(p) {
  const price = p.price.payable;
  const kcal = p.nutrition?.energyKcal ?? 0;
  const protein = p.nutrition?.protein ?? 0;
  // 价格权重为主，热量按每 100kcal 折算 0.5 元惩罚，蛋白质按每克折算 0.3 元奖励
  return price + (kcal / 100) * 0.5 - protein * 0.3;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 把「折扣率」转成中文折扣标签。
 *
 * @param {number|null} rate 实付 / 原价，0.662 表示 6.6 折
 * @returns {string|null} 如 '6.6折'；无折扣或无法计算时返回 null
 */
function discountLabel(rate) {
  if (rate == null || !Number.isFinite(rate)) return null;
  if (rate <= 0) return null;
  // 0.9995 以上视作无折扣，避免浮点误差把「原价」显示成「10.0折」
  if (rate >= 0.9995) return null;
  const zhe = Math.round(rate * 1000) / 100;
  const text = (zhe % 1 === 0) ? String(zhe) : zhe.toFixed(1);
  return `${text}折`;
}

/**
 * 把 calculate-price 的 productList 展开为「每件单价 + 每件折扣」明细。
 *
 * 实测：服务端已在 productList 里把优惠分摊到具体商品，例如
 *   不素之霸双层牛堡 orig 2650 sub 2650（无折扣）
 *   中薯条         orig 1450 sub 1450（无折扣）
 *   冰奶铁中杯     orig 2100 sub 1390（分摊后 6.6 折）
 * 三件 subtotal 之和 5490 恰等于整单 payable 54.90，因此可直接用 subtotal/originalSubtotal 反推折扣。
 *
 * 但并非所有场景都会分摊（例如部分活动只给整单 discount 而不落到行项目），
 * 因此当「行项目优惠合计」与「整单 discount」对不上时，按原价比例二次分摊，
 * 保证每件折扣之和与整单优惠自洽。
 *
 * @param {Array} productList calculate-price 返回的原始行项目
 * @param {number|null} totalDiscount 整单优惠金额（元）
 * @param {(v:*)=>number|null} toYuan 分转元
 * @returns {Array<{code:string,name:string,quantity:number,original:number|null,payable:number|null,unitOriginal:number|null,unitPayable:number|null,saved:number|null,discountRate:number|null,discountLabel:string|null}>}
 */
function buildPriceLines(productList, totalDiscount, toYuan) {
  if (!Array.isArray(productList)) return [];

  const lines = productList.map((p) => {
    const quantity = Number(p.quantity) || 1;
    const original = toYuan(p.originalSubtotal);
    const payable = toYuan(p.subtotal);
    const unitOriginal = original != null ? round2(original / quantity) : null;
    const unitPayable = payable != null ? round2(payable / quantity) : null;
    const saved = (original != null && payable != null) ? round2(original - payable) : null;
    const discountRate = (original != null && payable != null && original > 0)
      ? round2(payable / original)
      : null;
    return {
      code: p.productCode != null ? String(p.productCode) : null,
      name: p.productName != null ? String(p.productName) : (p.productCode != null ? String(p.productCode) : '未命名商品'),
      quantity,
      original,
      payable,
      unitOriginal,
      unitPayable,
      saved,
      discountRate,
      discountLabel: discountLabel(discountRate),
    };
  });

  // 行项目未分摊优惠时，按原价比例二次分摊，让每件折扣之和等于整单优惠
  const discount = typeof totalDiscount === 'number' && Number.isFinite(totalDiscount) ? totalDiscount : 0;
  if (discount > 0 && lines.length) {
    const allocated = round2(lines.reduce((s, l) => s + (l.saved || 0), 0));
    if (Math.abs(allocated - discount) > 0.011) {
      const baseTotal = lines.reduce((s, l) => s + (l.original || 0), 0);
      if (baseTotal > 0) {
        let remain = discount;
        lines.forEach((l, i) => {
          if (i === lines.length - 1) {
            // 最后一件兜底吸收尾差，避免四舍五入后合计差一分钱
            l.saved = round2(Math.max(0, remain));
          } else {
            const share = round2(discount * ((l.original || 0) / baseTotal));
            l.saved = round2(Math.min(share, l.original || 0));
            remain = round2(remain - l.saved);
          }
          if (l.payable != null && l.original != null) {
            l.payable = round2(Math.max(0, l.original - l.saved));
            l.unitPayable = round2(l.payable / l.quantity);
            l.discountRate = l.original > 0 ? round2(l.payable / l.original) : null;
            l.discountLabel = discountLabel(l.discountRate);
          }
        });
      }
    }
  }

  return lines;
}

/**
 * 把 calculate-price 的返回归一化为 {payable, original, discount, ...}。
 *
 * 实测要点：
 * 1. 金额以「分」为单位返回（2690 表示 ¥26.90），需统一换算为元；
 * 2. 商品售罄/不可售时返回 {success:false, code, message} 且**不带 data 层**——
 *    若不加判断直接解析，会把错误响应体当成业务数据，最后只得到「未返回金额」
 *    这种掩盖真实原因的提示，让人误以为接口挂了。这里优先识别业务失败并保留原始文案；
 * 3. 字段结构写错时接口不报错，而是静默返回 price=0 且商品列表为空，用 suspicious 标记；
 * 4. productList 的 subtotal 已包含服务端分摊的优惠，可据此反推「每件打了几折」。
 *
 * @param {object} payload
 * @returns {null|{failed:true,code:*,message:string,raw:*}|object}
 */
function normalizePriceResult(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // 业务失败优先：success 显式为 false，或存在错误码且没有 data 层
  const hasData = !!(payload.data && typeof payload.data === 'object');
  const code = payload.code ?? (hasData ? payload.data.code : undefined);
  const isFail = payload.success === false
    || (code !== undefined && code !== 0 && code !== '0' && !hasData && payload.success !== true);
  if (isFail) {
    return {
      failed: true,
      code: code ?? null,
      message: payload.message || (hasData ? payload.data.message : '') || '计价接口返回业务错误',
      raw: payload,
    };
  }

  // 业务数据位于 {success,code,message,data:{...}} 的 data 层
  const data = hasData ? payload.data : payload;

  const toYuan = (v) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(String(v).replace(/[^\d.-]/g, '')) : NaN;
    if (!Number.isFinite(n)) return null;
    return Math.round((n / 100) * 100) / 100;
  };

  const payable = toYuan(data.price ?? data.payAmount ?? data.payable);
  const original = toYuan(data.originalPrice ?? data.productOriginalPrice);
  const discount = toYuan(data.discount ?? data.discountAmount);
  const deliveryFee = toYuan(data.deliveryFee ?? data.shippingFee);

  // price=0 且商品列表为空通常意味着 items 字段结构不对（接口静默失败）
  const emptyProducts = !Array.isArray(data.productList) || data.productList.length === 0;

  if (payable === null && original === null) return null;

  const resolvedPayable = payable !== null ? payable : (original ?? 0) - (discount ?? 0) + (deliveryFee ?? 0);
  const lines = buildPriceLines(data.productList, discount, toYuan);

  // 整单口径：优先用行项目合计（服务端已分摊，最贴近真实），缺失时退回 original/discount
  const linesOriginal = lines.length ? round2(lines.reduce((s, l) => s + (l.original || 0), 0)) : null;
  const linesPayable = lines.length ? round2(lines.reduce((s, l) => s + (l.payable || 0), 0)) : null;
  const overallOriginal = original != null ? original : linesOriginal;
  const overallRate = (overallOriginal && overallOriginal > 0 && resolvedPayable != null)
    ? round2(resolvedPayable / overallOriginal)
    : null;

  return {
    payable: resolvedPayable,
    original,
    discount,
    deliveryFee,
    /** 每件商品的单价、实付与折扣明细 */
    lines,
    /** 整单折扣率与中文标签，如 0.89 / '8.9折' */
    overallRate,
    overallDiscountLabel: discountLabel(overallRate),
    /** 行项目原价合计（用于与 original 对账，正常情况下两者相等） */
    linesTotal: linesOriginal,
    linesPayable,
    productList: Array.isArray(data.productList) ? data.productList : [],
    suspicious: payable === 0 && emptyProducts,
    raw: data,
  };
}

module.exports = {
  buildPlans,
  rankPlans,
  normalizeCoupon,
  normalizeMeal,
  normalizePriceResult,
  buildPriceLines,
  discountLabel,
  extractArray,
  COUPON_ALIASES,
  MEAL_ALIASES,
};
