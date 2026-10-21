'use strict';

/**
 * 老虎机符号精选与开奖判定。
 *
 * 设计要点：
 * 1. 符号全部来自 MCP 的真实在售菜单（名称 + 图片 URL），不伪造素材。
 * 2. **只取单品，不要套餐**。套餐（「xx 三件套」「1+1 随心配」）由多个子餐品组成，
 *    营养库里没有对应记录，摇中后营养面板大面积为空；价格也只有组合价、拆不出单件单价。
 *    因此这里用 COMBO_EXCLUDE 做全局过滤，任何分类都进不来。
 * 3. 稀有符号（高赔付）改由各分类排序后的第一名担任，不再依赖套餐，
 *    保证去掉套餐后头奖档位依然存在。
 * 4. 分类靠名称关键词，顺序沿用菜单原始顺序，保证同一门店多次请求结果稳定。
 */

/**
 * 全局排除：命中即不进入滚轮。
 * 与分类内的 exclude 分开，是为了覆盖「分类补齐」那条兜底分支——
 * 否则符号不足时会从剩余菜单里随机捞，把套餐又塞回来。
 */
const COMBO_EXCLUDE = /件套|套餐|随心配|分享餐|双人餐|全家桶|拼盘|欢乐餐|超值餐|组合餐|大卡套餐|亲子餐/;

/** 判断某餐品是否为套餐（多子件组合） */
function isComboMeal(meal) {
  const name = (meal && meal.name) || '';
  return COMBO_EXCLUDE.test(name) || !!(meal && meal.hasRounds);
}

/** 分类规则：match 命中且不被 exclude 命中即归入该类 */
const CATEGORY_RULES = [
  {
    key: 'burger',
    label: '汉堡',
    accent: '#E8A33D',
    match: /堡|汉堡/,
    exclude: /八件|四件|三件|拼|精选/,
    preferSingle: true,
    limit: 3,
    rareTop: 1,
  },
  {
    key: 'side',
    label: '小食',
    accent: '#E8C33D',
    match: /薯条|玉米杯|薯格|扭扭薯|星星/,
    exclude: /拼盘|耳机包|绒绒/,
    preferSingle: true,
    limit: 2,
  },
  {
    key: 'chicken',
    label: '炸鸡',
    accent: '#D9702A',
    match: /鸡块|鸡翅|麦乐鸡|鸡排|脆汁鸡/,
    exclude: /拼盘|蘸酱/,
    preferSingle: true,
    limit: 2,
    rareTop: 1,
  },
  {
    key: 'dessert',
    label: '甜品',
    accent: '#D96BA0',
    match: /麦旋风|圆筒|新地|冰淇淋|^派$|派$/,
    exclude: /拼盘|饼干|周边|耳机包|绒绒|袋/,
    preferSingle: true,
    limit: 2,
  },
  {
    key: 'drink',
    label: '饮品',
    accent: '#4FA3D1',
    match: /可乐|咖啡|红茶|牛奶|果汁|雪冰|美禄|阿芙佳朵|怡泉|柠柠|橙橙|麦炫酷/,
    exclude: /一夏/,
    preferSingle: true,
    limit: 2,
  },
];

/**
 * 从菜单中挑选老虎机符号。
 * @param {Array} menu loadMenu 产出的菜单项 {code,name,category,image,hasRounds}
 * @param {Object} [options]
 * @param {(meal:Object)=>boolean} [options.hasNutrition] 判断该餐品能否算出营养，
 *        用于在同一分类内优先选择能算出营养的餐品（新品与套餐普遍无法给出可信数据）
 * @returns {Array} 符号数组
 */
function pickSymbols(menu, { hasNutrition = null } = {}) {
  if (!Array.isArray(menu) || !menu.length) return [];

  const used = new Set();
  const symbols = [];

  for (const rule of CATEGORY_RULES) {
    const candidates = menu.filter((m) => {
      if (used.has(m.code)) return false;
      if (!m.name || !m.image) return false;
      // 全局过滤：套餐一律不进滚轮（含「其他」补齐分支）
      if (isComboMeal(m)) return false;
      if (rule.match && !rule.match.test(m.name)) return false;
      if (rule.exclude && rule.exclude.test(m.name)) return false;
      return true;
    });

    // 排序优先级：有营养数据 > 单品 > 菜单原始顺序
    const rank = (c) => {
      const n = hasNutrition ? (hasNutrition(c) ? 0 : 1) : 0;
      const single = rule.preferSingle && c.hasRounds ? 1 : 0;
      return n * 2 + single;
    };
    const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));

    ordered.slice(0, rule.limit).forEach((c, idxInRule) => {
      used.add(c.code);
      symbols.push({
        id: c.code,
        code: c.code,
        name: c.name,
        image: c.image,
        category: rule.key,
        categoryLabel: rule.label,
        accent: rule.accent,
        // 稀有档位由分类内的第一名担任（如招牌汉堡、招牌炸鸡），
        // 去掉套餐分类后头奖档位仍然保留
        rare: (rule.rareTop || 0) > idxInRule,
        isCombo: false,
        menuCategory: c.category || null,
      });
    });
  }

  // 符号不足时（菜单结构异常）用剩余带图单品补齐，保证滚轮不会空转
  if (symbols.length < 6) {
    for (const m of menu) {
      if (symbols.length >= 6) break;
      if (used.has(m.code) || !m.image || !m.name) continue;
      if (isComboMeal(m)) continue;
      used.add(m.code);
      symbols.push({
        id: m.code,
        code: m.code,
        name: m.name,
        image: m.image,
        category: 'other',
        categoryLabel: '其他',
        accent: '#7F8C8D',
        rare: false,
        isCombo: false,
        menuCategory: m.category || null,
      });
    }
  }

  // 兜底：若一个稀有符号都没有（菜单命名不常规），把第一个符号提为稀有，
  // 避免头奖分支因 rares 为空而永远不触发
  if (symbols.length && !symbols.some((s) => s.rare)) symbols[0].rare = true;

  return symbols.map((s, i) => ({ ...s, weight: s.rare ? 6 : 14, index: i }));
}

/** 单局消耗与初始金币 */
const SPIN_COST = 10;
const START_CREDITS = 200;

/**
 * 开奖概率表。
 *
 * 这里是刻意的设计选择：如果三个滚轮各自独立随机，三连概率只有约 0.2%，
 * 玩家几乎永远看不到中奖，游戏就没有反馈。真实老虎机也是先由 RNG 决定结果，
 * 再驱动滚轮停到对应位置——本项目沿用同样的思路。
 *
 * 期望赔付 ≈ 0.015×200 + 0.07×60 + 0.25×9 ≈ 9.2，略低于 10 的成本，
 * 保证玩家能玩很久但总体缓慢消耗。
 */
const ODDS = { jackpot: 0.015, triple: 0.07, pair: 0.25 };

/** 按权重随机抽取一个符号 */
function weightedPick(symbols, rand = Math.random) {
  if (!symbols.length) return null;
  const total = symbols.reduce((sum, s) => sum + (Number(s.weight) || 1), 0);
  let r = rand() * total;
  for (const s of symbols) {
    r -= Number(s.weight) || 1;
    if (r <= 0) return s;
  }
  return symbols[symbols.length - 1];
}

function pickOne(list, rand) {
  if (!list.length) return null;
  return list[Math.floor(rand() * list.length)];
}

/** 把数组随机打乱（Fisher-Yates） */
function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 摇一次，返回三个滚轮最终停下的符号。
 * 结果由概率表先决定，再据此摆放滚轮位置。
 */
function spin(symbols, rand = Math.random) {
  if (!symbols || symbols.length < 2) return symbols ? symbols.slice(0, 3) : [];

  const rares = symbols.filter((s) => s.rare);
  const commons = symbols.filter((s) => !s.rare);
  const roll = rand();

  // 超级大奖：稀有符号（招牌单品）三连
  if (roll < ODDS.jackpot && rares.length) {
    const s = weightedPick(rares, rand);
    return [s, s, s];
  }

  // 三连：普通符号三连
  if (roll < ODDS.jackpot + ODDS.triple && commons.length) {
    const s = weightedPick(commons, rand);
    return [s, s, s];
  }

  // 两连：两个相同 + 一个不同
  if (roll < ODDS.jackpot + ODDS.triple + ODDS.pair) {
    const a = weightedPick(symbols, rand);
    const others = symbols.filter((s) => s.id !== a.id);
    if (others.length) {
      const b = weightedPick(others, rand);
      return shuffle([a, a, b], rand);
    }
    return [a, a, a];
  }

  // 未中奖：三个互不相同
  const pool = shuffle(symbols, rand).slice(0, 3);
  while (pool.length < 3 && symbols.length) pool.push(pickOne(symbols, rand));
  return pool;
}

/**
 * 判定中奖。
 * 三个相同：头奖；两个相同：小奖；全不同：未中奖（但仍给出这一餐的营养与价格）。
 * 稀有符号（招牌单品）三连额外加倍。
 */
function evaluate(reels) {
  if (!Array.isArray(reels) || reels.length !== 3 || reels.some((r) => !r)) {
    return { level: 'none', payout: 0, title: '未中奖', desc: '' };
  }

  const [a, b, c] = reels;
  const counts = new Map();
  for (const r of reels) counts.set(r.id, (counts.get(r.id) || 0) + 1);
  const maxCount = Math.max(...counts.values());

  if (maxCount === 3) {
    const rare = a.rare;
    const payout = rare ? 200 : 60;
    return {
      level: rare ? 'jackpot' : 'triple',
      payout,
      title: rare ? '超级大奖' : '三连中奖',
      desc: `三连「${a.name}」${rare ? '，招牌单品加成' : ''}`,
      combo: true,
    };
  }

  if (maxCount === 2) {
    const hitId = [...counts.entries()].find(([, n]) => n === 2)[0];
    const hit = reels.find((r) => r.id === hitId);
    return {
      level: 'pair',
      payout: hit.rare ? 15 : 8,
      title: '小奖',
      desc: `两连「${hit.name}」`,
    };
  }

  return {
    level: 'none',
    payout: 0,
    title: '未中奖',
    desc: '三样都不同，不过这一餐依然可以看看营养',
  };
}

/**
 * 滚轮停止位置计算：把目标符号放到视口中心。
 * 返回每列需要滚动到的偏移（单位：格）。
 */
function reelStopOffsets(symbols, targets, { extraRounds = 3 } = {}) {
  const n = symbols.length;
  return targets.map((t) => {
    const idx = symbols.findIndex((s) => s.id === t.id);
    const base = idx >= 0 ? idx : 0;
    return extraRounds * n + base;
  });
}

module.exports = {
  CATEGORY_RULES,
  COMBO_EXCLUDE,
  isComboMeal,
  SPIN_COST,
  START_CREDITS,
  ODDS,
  pickSymbols,
  weightedPick,
  spin,
  shuffle,
  evaluate,
  reelStopOffsets,
};
