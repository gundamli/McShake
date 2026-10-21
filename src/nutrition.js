'use strict';

/**
 * 营养数据处理
 *
 * 数据源：MCP 工具 list-nutrition-foods（餐品营养信息列表）
 * 由于官方未公开返回字段的确切命名，这里用同义词表做启发式字段识别，
 * 中英文常见写法都覆盖，字段变化时无需改代码即可适配。
 */

const FIELD_ALIASES = {
  name: ['name', 'foodName', 'food_name', 'productName', 'product_name', 'title', 'mealName', 'meal_name', '名称', '餐品名称', '食品名称', '商品名称'],
  code: ['code', 'mealCode', 'meal_code', 'productCode', 'product_code', 'sku', 'id', '编码', '餐品编码', '商品编码'],
  // 实测官方字段为 energyKcal / energyKj，两者分开取，避免千焦被误当千卡
  energyKcal: ['energyKcal', 'kcal', 'calories', 'calorie', '热量', '千卡', '大卡', '卡路里'],
  energyKj: ['energyKj', 'kj', '千焦', '能量'],
  protein: ['protein', '蛋白质', '蛋白'],
  fat: ['fat', '脂肪', '油脂'],
  carb: ['carbohydrate', 'carb', 'carbs', '碳水化合物', '碳水', '糖类'],
  sodium: ['sodium', 'na', '钠', '盐'],
  calcium: ['calcium', 'ca', '钙'],
  weight: ['weight', 'netWeight', 'net_weight', '克重', '净含量', '重量', '规格'],
  unit: ['unit', '单位'],
};

/**
 * 中国食品标签营养素参考值（NRV，成人每日）
 * 键名必须与 summarize 输出的 total 字段一致，否则该项的占比不会生成。
 */
const NRV = {
  energyKcal: { daily: 2000, unit: 'kcal', label: '能量' },
  protein: { daily: 60, unit: 'g', label: '蛋白质' },
  fat: { daily: 60, unit: 'g', label: '脂肪' },
  carb: { daily: 300, unit: 'g', label: '碳水化合物' },
  sodium: { daily: 2000, unit: 'mg', label: '钠' },
  calcium: { daily: 800, unit: 'mg', label: '钙' },
};

/** 单餐合理占比（按每日三餐计，约 33%） */
const MEAL_SHARE = 0.33;

function pickField(record, aliases) {
  for (const key of aliases) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  // 退而求其次：不区分大小写与下划线
  const norm = (s) => String(s).toLowerCase().replace(/[\s_-]/g, '');
  const wanted = aliases.map(norm);
  for (const [k, v] of Object.entries(record)) {
    if (v === undefined || v === null || v === '') continue;
    if (wanted.includes(norm(k))) return v;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  // 兼容 "512 kcal"、"1,024千焦"、"12.5g" 这类带单位的写法
  const m = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = pickField(raw, FIELD_ALIASES.name);
  if (!name) return null;

  // 千卡优先；仅当只有千焦时按 1 kcal = 4.184 kJ 换算
  const rawKcal = toNumber(pickField(raw, FIELD_ALIASES.energyKcal));
  const rawKj = toNumber(pickField(raw, FIELD_ALIASES.energyKj));
  let energyKcal = null;
  let energyKj = null;
  if (rawKcal !== null) {
    energyKcal = Math.round(rawKcal);
    energyKj = Math.round(rawKcal * 4.184);
  } else if (rawKj !== null) {
    energyKj = Math.round(rawKj);
    energyKcal = Math.round(rawKj / 4.184);
  }

  return {
    raw,
    code: pickField(raw, FIELD_ALIASES.code) ? String(pickField(raw, FIELD_ALIASES.code)) : null,
    name: String(name),
    energyKcal,
    energyKj,
    protein: toNumber(pickField(raw, FIELD_ALIASES.protein)),
    fat: toNumber(pickField(raw, FIELD_ALIASES.fat)),
    carb: toNumber(pickField(raw, FIELD_ALIASES.carb)),
    sodium: toNumber(pickField(raw, FIELD_ALIASES.sodium)),
    calcium: toNumber(pickField(raw, FIELD_ALIASES.calcium)),
    weight: toNumber(pickField(raw, FIELD_ALIASES.weight)),
  };
}

/** 归一化用于比对的菜名：去空格、去括号内容、统一大小写 */
function normalizeName(name) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[•·、,，.。!！]/g, '')
    .toLowerCase();
}

/** 提取中文/英文/数字词块，用于分词匹配 */
function tokenize(name) {
  const s = normalizeName(name);
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || [];
  const latin = s.match(/[a-z0-9]+/g) || [];
  const bigrams = [];
  for (const seg of cjk) {
    if (seg.length < 2) { bigrams.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) bigrams.push(seg.slice(i, i + 2));
  }
  return { cjk, latin, bigrams, all: [...new Set([...cjk, ...latin, ...bigrams])] };
}

/**
 * 计算两个菜名的相似度（0~1）
 *
 * 分层判定：
 *   1. 完全一致 → 1
 *   2. 一方包含另一方（如「可乐」/「可口可乐」）→ 0.82~0.97，按长度比加权
 *   3. 否则综合二元组重叠系数与字符集合 Jaccard 相似度
 *
 * 说明：第 3 层刻意采用「重叠系数 = 交集 / min(两者规模)」而非 Jaccard，
 * 因为菜名常有「麦辣鸡腿堡 / 麦辣鸡腿汉堡」这类长短差异，
 * 用 Jaccard 会因长串的独有词而把分数稀释到无法识别。
 * 上限压到 0.8 以保留与真正包含关系的区分度。
 */
function similarity(query, target) {
  const a = normalizeName(query);
  const b = normalizeName(target);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const short = Math.min(a.length, b.length);
    const long = Math.max(a.length, b.length);
    return 0.82 + 0.15 * (short / long);
  }

  const ta = tokenize(query);
  const tb = tokenize(target);

  const setA = new Set(ta.bigrams);
  const setB = new Set(tb.bigrams);
  let hit = 0;
  for (const t of setA) if (setB.has(t)) hit++;
  const minSize = Math.min(setA.size, setB.size) || 1;
  const overlap = hit / minSize;

  const ca = new Set(a.split(''));
  const cb = new Set(b.split(''));
  let charHit = 0;
  for (const ch of ca) if (cb.has(ch)) charHit++;
  const charJaccard = charHit / (new Set([...ca, ...cb]).size || 1);

  let score = Math.max(overlap * 0.8, charJaccard * 0.95);
  for (const w of ta.latin) {
    if (tb.latin.includes(w)) score = Math.max(score, 0.6);
  }
  return Math.min(score, 0.8);
}

class NutritionLibrary {
  constructor() {
    this.records = [];
    this.loadedAt = 0;
    this.source = null;
  }

  /**
   * 从 list-nutrition-foods 的返回中抽取记录数组。
   * 返回结构可能是 {foods:[...]} / {data:[...]} / {list:[...]} / 纯数组 / {content:[...]}。
   */
  static extractArray(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['foods', 'list', 'data', 'items', 'records', 'result', 'results', 'nutritionList', 'nutrition']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    for (const value of Object.values(payload)) {
      if (Array.isArray(value) && value.length && typeof value[0] === 'object') return value;
    }
    return [];
  }

  load(payload) {
    const arr = NutritionLibrary.extractArray(payload);
    this.records = arr.map(normalizeRecord).filter(Boolean);
    this.loadedAt = Date.now();
    this.source = payload;
    return this.records.length;
  }

  get size() {
    return this.records.length;
  }

  /** 按名称匹配，返回按相似度降序的候选（含分值） */
  match(query, { limit = 5, threshold = 0.35 } = {}) {
    if (!query) return [];
    const scored = this.records
      .map((r) => ({ record: r, score: similarity(query, r.name) }))
      .filter((x) => x.score >= threshold)
      .sort((x, y) => y.score - x.score);
    return scored.slice(0, limit);
  }

  best(query) {
    const hits = this.match(query, { limit: 1 });
    return hits.length ? hits[0] : null;
  }
}

/**
 * 汇总一组餐品的营养数据
 * items: [{ name, code, quantity, nutrition }]
 */
function summarize(items) {
  const keys = ['energyKcal', 'energyKj', 'protein', 'fat', 'carb', 'sodium', 'calcium'];
  const total = {};
  for (const k of keys) total[k] = 0;

  const rows = [];
  let matchedCount = 0;

  for (const item of items) {
    const n = item.nutrition;
    const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
    if (n) {
      matchedCount++;
      for (const k of keys) {
        const v = Number(n[k]) || 0;
        total[k] += v * qty;
      }
    }
    rows.push({
      name: item.name,
      code: item.code || (n && n.code) || null,
      quantity: qty,
      matched: Boolean(n),
      matchScore: item.matchScore ?? null,
      nutrition: n
        ? {
            energyKcal: Math.round((Number(n.energyKcal) || 0) * qty),
            protein: round1((Number(n.protein) || 0) * qty),
            fat: round1((Number(n.fat) || 0) * qty),
            carb: round1((Number(n.carb) || 0) * qty),
            sodium: Math.round((Number(n.sodium) || 0) * qty),
            calcium: Math.round((Number(n.calcium) || 0) * qty),
          }
        : null,
    });
  }

  for (const k of keys) total[k] = k.startsWith('energy') ? Math.round(total[k]) : round1(total[k]);

  const vsNrv = {};
  for (const k of ['energyKcal', 'protein', 'fat', 'carb', 'sodium', 'calcium']) {
    const meta = NRV[k];
    if (!meta) continue;
    vsNrv[k] = {
      label: meta.label,
      unit: meta.unit,
      value: total[k],
      dailyPercent: meta.daily ? round1((total[k] / meta.daily) * 100) : null,
      mealPercent: meta.daily ? round1((total[k] / (meta.daily * MEAL_SHARE)) * 100) : null,
    };
  }

  return {
    total,
    vsNrv,
    rows,
    matchedCount,
    unmatchedCount: rows.length - matchedCount,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/**
 * 无厘头安慰话术库。
 *
 * 营养建议写得再严谨，也拦不住一个人深夜想吃双层芝士汉堡。与其在超标时
 * 只会说「建议减少摄入」（用户大概率不会听），不如承认情绪价值同样是配餐的一部分。
 * 这些句子只做情绪缓冲，不替代上面的严肃提示，因此在前端以独立样式呈现。
 */
const FUN_LINES = {
  energy: [
    '只要吃得爽，热量不存在。',
    '这顿的热量已经被你的快乐提前消耗掉了。',
    '卡路里是能量，你这是在为下午充电，不是长胖。',
    '吃饱了才有力气减——这句话虽然不科学，但很好用。',
  ],
  sodium: [
    '钠含量确实高，但你的眼泪也是咸的，扯平了。',
    '人生已经够淡了，这顿咸一点怎么了。',
    '重口味是勇敢者的勋章，多喝水就好。',
    '今天的钠摄入超标了，但今天的你也超可爱。',
  ],
  fat: [
    '脂肪是风味的载体，你只是在追求风味。',
    '香的东西都长胖，这是物理规律，不是你的错。',
    '油炸食品的快乐是水煮菜给不了的。',
    '这点脂肪，明天走两步就消耗了——大概。',
  ],
  carb: [
    '碳水是大脑唯一的燃料，你这是在工作。',
    '吃饱碳水才有劲思考人生，这是刚需。',
    '面包薯条可乐，碳水的三重奏，艺术。',
  ],
  balanced: [
    '这顿搭配相当克制，值得表扬——虽然好像没必要。',
    '营养均衡到有点无聊，下次可以考虑放纵一下。',
    '各项指标都很健康，健康得让人有点担心你是不是不开心。',
  ],
  generic: [
    '数据仅供参考，开心才是主食。',
    '营养表仅供参考，你的嘴才是最终裁判。',
    '这顿饭的评价权在你，不在我这张表里。',
    '吃完记得喝口水，这是全篇唯一的医学建议。',
  ],
};

/**
 * 按汇总结果确定性地挑一句无厘头话术。
 *
 * 用「营养数值」而不是 Math.random 做种子：同一顿饭刷新后句子不变（不像抽盲盒），
 * 换一顿饭才会换一句（不至于每次都看同一句）。
 */
function pickFunLine(summary) {
  const t = summary.total || {};
  const nrv = summary.vsNrv || {};
  const pct = (k) => (nrv[k] && typeof nrv[k].mealPercent === 'number') ? nrv[k].mealPercent : 0;

  const over = [];
  if (pct('energyKcal') >= 100) over.push('energy');
  if (pct('sodium') >= 100) over.push('sodium');
  if (pct('fat') >= 100) over.push('fat');
  if (pct('carb') >= 100) over.push('carb');

  let pool;
  if (over.length) {
    // 超标时优先吐槽超得最狠的那一项
    const worst = over.slice().sort((a, b) => pct(a === 'energy' ? 'energyKcal' : a) - pct(b === 'energy' ? 'energyKcal' : b))[0];
    pool = FUN_LINES[worst] || FUN_LINES.generic;
  } else if (summary.matchedCount > 0 && Object.values(nrv).every((v) => (v.mealPercent || 0) < 80)) {
    pool = FUN_LINES.balanced;
  } else {
    pool = FUN_LINES.generic;
  }

  const seed = Math.abs(Math.round((t.energyKcal || 0) * 7 + (t.sodium || 0) * 13 + (t.fat || 0) * 3 + (t.protein || 0) * 5));
  return pool[seed % pool.length];
}

/** 基于营养汇总给出健康提示（规则化，非医疗建议） */
function buildHealthNotes(summary) {
  const notes = [];
  const t = summary.total;
  const nrv = summary.vsNrv;

  if (nrv.sodium && nrv.sodium.mealPercent >= 100) {
    notes.push({ level: 'warn', text: `钠含量 ${t.sodium}mg，已达单餐参考值的 ${nrv.sodium.mealPercent}%，建议减少酱料或搭配无盐饮品。` });
  } else if (nrv.sodium && nrv.sodium.mealPercent >= 70) {
    notes.push({ level: 'info', text: `钠含量 ${t.sodium}mg（单餐参考值 ${nrv.sodium.mealPercent}%），处于偏高区间。` });
  }

  if (nrv.energyKcal && nrv.energyKcal.mealPercent >= 120) {
    notes.push({ level: 'warn', text: `热量 ${t.energyKcal} kcal，超出单餐参考值，减脂期建议替换为沙拉或去掉薯条。` });
  }

  if (t.protein > 0 && t.energyKcal > 0) {
    const proteinEnergyRatio = (t.protein * 4) / t.energyKcal;
    if (proteinEnergyRatio < 0.1) {
      notes.push({ level: 'info', text: `蛋白质供能比仅 ${Math.round(proteinEnergyRatio * 100)}%，偏低，可加一份鸡块或牛奶补充。` });
    } else if (proteinEnergyRatio >= 0.2) {
      notes.push({ level: 'good', text: `蛋白质供能比 ${Math.round(proteinEnergyRatio * 100)}%，配比不错。` });
    }
  }

  if (t.fat > 0 && t.energyKcal > 0) {
    const fatRatio = (t.fat * 9) / t.energyKcal;
    if (fatRatio > 0.45) {
      notes.push({ level: 'warn', text: `脂肪供能比 ${Math.round(fatRatio * 100)}% 偏高，主要来源通常是油炸品与酱料。` });
    }
  }

  if (summary.unmatchedCount > 0) {
    notes.push({
      level: 'info',
      text: `有 ${summary.unmatchedCount} 项是新品，麦当劳 MCP 的营养库还没收录——没数据不代表没营养，就当它是 0 糖 0 卡 0 脂（本条纯属玩笑）。`,
    });
  }

  if (notes.length === 0) {
    notes.push({ level: 'good', text: '各项营养指标处于合理区间。' });
  }

  // 彩蛋：严肃建议给完了，再补一句无厘头的。超标也照样给——
  // 用户要的是「被理解」，不是「被教育」。
  notes.push({ level: 'fun', text: pickFunLine(summary) });
  return notes;
}

module.exports = {
  NutritionLibrary,
  normalizeRecord,
  similarity,
  summarize,
  buildHealthNotes,
  pickFunLine,
  FUN_LINES,
  NRV,
  MEAL_SHARE,
};
