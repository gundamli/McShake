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
  findDeals,
  discountLabel,
};
