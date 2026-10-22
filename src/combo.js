'use strict';

/**
 * 1+1 随心配（多分区套餐）的识别与拼单。
 *
 * 为什么单独一个模块：
 *   老虎机的滚轮只收单品（套餐拆不出单件营养与单价），但「1+1 随心配」
 *   恰恰是把两个**单品**拼成一个组合价——两件事并不矛盾。滚轮照旧摇单品，
 *   出账时再检查这单能不能拼成套餐，能拼就按套餐价展示更低的实付金额。
 *
 * 实测契约（2026-10-21，真实 Token）：
 *   - query-meal-detail 的 `rounds[]` 给出每个分区（蓝区 / 粉区）的可选子件与差价：
 *     `{ id: 1, name: '蓝区', quantity: 1, maxQuantity: 1,
 *        choices: [{ code: '1120', name: '双层吉士汉堡', diffPrice: '+ ¥0' }] }`
 *   - calculate-price 用 `items[].roundList` 传子件时按**套餐价**结算：
 *     `items: [{ productCode: '9900013304', quantity: 1,
 *                roundList: [{ round: '1', comboItemList: [{ code: '1120', quantity: 1 }] },
 *                            { round: '2', comboItemList: [{ code: '3050', quantity: 1 }] }] }]`
 *     实测返回 `price: 1490`（即 ¥14.90），而这两件单点合计 ¥23.00。
 *   - 套餐与额外单品可以在**同一次** calculate-price 里一起算（实测 1490 + 2350 = 3840），
 *     所以拼单不需要拆成两笔。
 */

/** 套餐名称特征：只认「1+1 / 随心配」这类可拼单套餐 */
const COMBO_NAME = /随心配|1\s*[+＋]\s*1/i;

/**
 * 解析差价文案：「+ ¥0」「- ¥1」「+¥2.5」→ 0 / -1 / 2.5
 * 官方的 `diffPrice` 是字符串，直接参与计算会得到 NaN。
 * @param {string|number} v
 * @returns {number}
 */
function parseDiffPrice(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (!v) return 0;
  // 「- ¥1」的负号与数字之间隔着货币符号和空格，不能用「第一个数字」直接取
  const cleaned = String(v).replace(/[^\d.\-+]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把 detail.rounds 归一化成内部结构，过滤掉没有 choices 的空分区。
 * @param {Array} rounds
 * @returns {Array<{id:string,name:string,quantity:number,choices:Array}>}
 */
function normalizeRounds(rounds) {
  if (!Array.isArray(rounds)) return [];
  return rounds
    .filter((r) => r && Array.isArray(r.choices) && r.choices.length)
    .map((r) => ({
      id: String(r.id),
      name: String(r.name || `第${r.id}区`),
      quantity: Number(r.quantity) > 0 ? Number(r.quantity) : 1,
      choices: r.choices
        .filter((c) => c && c.code != null)
        .map((c) => ({
          code: String(c.code),
          name: String(c.name || c.code),
          diffPrice: parseDiffPrice(c.diffPrice),
          isDefault: !!c.isDefault,
        })),
    }));
}

/**
 * 建立「单品 code → 它能进哪些套餐的哪个分区」的正向索引。
 *
 * @param {Array<{code:string,name:string,rounds:Array}>} details 各个套餐的 query-meal-detail 结果
 * @returns {{combos:Array, slotMap:Object, size:number}}
 */
function buildComboIndex(details) {
  const combos = [];
  const slotMap = {};

  for (const d of Array.isArray(details) ? details : []) {
    if (!d || d.code == null) continue;
    const rounds = normalizeRounds(d.rounds);
    if (rounds.length < 2) continue;

    const combo = {
      code: String(d.code),
      name: String(d.name || d.code),
      rounds,
    };
    combos.push(combo);

    for (const r of rounds) {
      for (const c of r.choices) {
        if (!slotMap[c.code]) slotMap[c.code] = [];
        slotMap[c.code].push({
          comboCode: combo.code,
          comboName: combo.name,
          round: r.id,
          roundName: r.name,
          diffPrice: c.diffPrice,
          choiceName: c.name,
        });
      }
    }
  }

  return { combos, slotMap, size: combos.length };
}

/**
 * 在摇出的若干单品里找出所有能拼成 1+1 的两件组合。
 *
 * 同一件商品可能同时出现在蓝区与粉区（官方允许），所以判断依据是
 * **两个位置分属同一套餐的不同 round**，而不是「两个不同的 code」。
 *
 * @param {string[]} codes 摇出的餐品编码（允许重复）
 * @param {Object} index buildComboIndex 的返回值
 * @returns {Array<{comboCode:string,comboName:string,slots:Array,roundList:Array,diffSum:number}>}
 */
function findDeals(codes, index) {
  const list = Array.isArray(codes) ? codes.map(String) : [];
  if (!index || !index.slotMap || list.length < 2) return [];

  const deals = [];
  const seen = new Set();

  for (let i = 0; i < list.length; i++) {
    const membersA = index.slotMap[list[i]];
    if (!membersA) continue;
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const membersB = index.slotMap[list[j]];
      if (!membersB) continue;

      for (const a of membersA) {
        for (const b of membersB) {
          // 必须同属一个套餐，且落在不同分区
          if (a.comboCode !== b.comboCode || a.round === b.round) continue;
          // 同一对位置 + 同一套餐只保留一条（避免 a/b 互换重复）
          const key = `${a.comboCode}|${[i, j].sort().join(',')}|${[a.round, b.round].sort().join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const slots = [a, b].map((m) => ({
            round: m.round,
            roundName: m.roundName,
            code: m.round === a.round ? list[i] : list[j],
            name: m.choiceName,
            diffPrice: m.diffPrice,
          }));

          deals.push({
            comboCode: a.comboCode,
            comboName: a.comboName,
            slots,
            roundList: slots.map((s) => ({
              round: String(s.round),
              comboItemList: [{ code: String(s.code), quantity: 1 }],
            })),
            diffSum: slots.reduce((sum, s) => sum + s.diffPrice, 0),
          });
        }
      }
    }
  }

  // 差价合计越低越划算，同价时保持菜单原始顺序（sort 稳定）
  return deals.sort((x, y) => x.diffSum - y.diffSum);
}

/**
 * 从多套随心配里挑出「能玩的那一套」，并给出两个分区各自的可选子件。
 *
 * 为什么必须限定在**同一套**套餐里：
 *   1+1 的成立条件是「两件同属一个套餐、且落在不同分区」（见 findDeals）。
 *   把「人气经典」的蓝区和「精选超值」的粉区凑在一起是拼不成套餐价的——
 *   这也是为什么这里不以「所有套餐的 choices 取并集」来摇第一二行。
 *
 * 选哪一套：两个分区都要有货，且**两侧件数的乘积最大**（可摇出的组合最多）。
 * 只有一套时自然是它；没有任何可用套餐时返回 available:false 由前端给出负状态。
 *
 * @param {Array<{code:string,name:string,rounds:Array}>} details query-meal-detail 的结果
 * @param {{ minChoices?: number }} [options] minChoices 低于此数量视为「凑不出玩法」
 * @returns {Object}
 */
function pickComboPlan(details, { minChoices = 1 } = {}) {
  const empty = {
    available: false, reason: 'no_combo', comboCode: null, comboName: null, rounds: [],
  };

  const plans = [];
  for (const d of Array.isArray(details) ? details : []) {
    if (!d || d.code == null) continue;
    const rounds = normalizeRounds(d.rounds);
    // 两分区套餐才谈得上「1+1」；三分区以上的组合套餐不走这条链路
    const pair = rounds.slice(0, 2);
    if (pair.length < 2) continue;
    if (pair.some((r) => r.choices.length < minChoices)) continue;

    plans.push({
      available: true,
      reason: null,
      comboCode: String(d.code),
      comboName: String(d.name || d.code),
      rounds: pair.map((r) => ({
        id: r.id,
        name: r.name,
        choices: r.choices.map((c) => ({ code: c.code, name: c.name, diffPrice: c.diffPrice })),
      })),
    });
  }

  if (!plans.length) {
    // 有套餐但区块数量不够，与「压根没有随心配」提示不同
    const hadAny = Array.isArray(details) && details.some((d) => d && normalizeRounds(d.rounds).length);
    return Object.assign({}, empty, { reason: hadAny ? 'too_few' : 'no_combo' });
  }

  plans.sort((a, b) => {
    const size = (p) => p.rounds.reduce((n, r) => n * Math.max(0, r.choices.length), 1);
    const diff = size(b) - size(a);
    if (diff !== 0) return diff;
    // 组合数相同时按套餐编码稳定排序，避免同一门店每次开出不同套餐
    return String(a.comboCode).localeCompare(String(b.comboCode));
  });
  return plans[0];
}

/**
 * 建立「子件 code → 名称 / 所属套餐 / 所属分区」的兜底表。
 *
 * 用途：1+1 分区里有一部分是**套餐专属子件**（例如 `3050 可乐中杯`），
 * 它们不在门店菜单里。`/api/slot/result` 原本以菜单还原餐品信息，这类 code
 * 会被显示成一串数字、营养全空。用这张表兜底后，名称取自套餐 choices，
 * 营养仍走同一套名称匹配。
 *
 * @param {Array} combos buildComboIndex 产出的 combos
 * @returns {Map<string, {code,name,comboCode,comboName,round,roundName}>}
 */
function buildChoiceMap(combos) {
  const map = new Map();
  for (const c of Array.isArray(combos) ? combos : []) {
    for (const r of c.rounds || []) {
      for (const ch of r.choices) {
        const key = String(ch.code);
        if (map.has(key)) continue; // 同一件出现在多套套餐里，名称一样，留第一条
        map.set(key, {
          code: key,
          name: ch.name,
          comboCode: String(c.code),
          comboName: String(c.name || c.code),
          round: String(r.id),
          roundName: r.name,
        });
      }
    }
  }
  return map;
}

/**
 * 折扣文案：14.9 / 23 → 「6.5 折」
 * @param {number} payable
 * @param {number} listTotal
 * @returns {string|null}
 */
function discountLabel(payable, listTotal) {
  if (!(payable > 0) || !(listTotal > 0) || payable >= listTotal) return null;
  const rate = (payable / listTotal) * 10;
  const text = rate >= 9.95 ? '9.9' : rate.toFixed(1);
  return `${text} 折`;
}

module.exports = {
  COMBO_NAME,
  parseDiffPrice,
  normalizeRounds,
  buildComboIndex,
  pickComboPlan,
  buildChoiceMap,
  findDeals,
  discountLabel,
};
