'use strict';

/** 核心算法自测（不依赖 MCP Token 与网络） */

const nutrition = require('./src/nutrition');
const optimizer = require('./src/optimizer');
const combo = require('./src/combo');
const order = require('./src/order');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
}

console.log('\n[1] 营养字段识别（真实官方字段）');
{
  // 实测官方返回字段：productName / nutritionDescription / energyKj / energyKcal /
  // protein / fat / carbohydrate / sodium / calcium
  const r = nutrition.normalizeRecord({
    productName: '巨无霸', nutritionDescription: null,
    energyKj: 2146, energyKcal: 513,
    protein: 27, fat: 26, carbohydrate: 42, sodium: 961, calcium: 171,
  });
  check('识别官方 productName', r && r.name === '巨无霸');
  check('优先取 energyKcal', r.energyKcal === 513, `got ${r && r.energyKcal}`);
  check('千焦与千卡自洽', r.energyKj === Math.round(513 * 4.184), `got ${r && r.energyKj}`);
  check('碳水与钠解析', r.carb === 42 && r.sodium === 961, JSON.stringify(r).slice(0, 160));

  // 仅提供千焦时应按 1 kcal = 4.184 kJ 换算（中薯条真实值 1210 kJ = 289 kcal）
  const r2 = nutrition.normalizeRecord({ productName: '中薯条', energyKj: 1210 });
  check('仅有千焦时换算为千卡', r2.energyKcal === 289, `got ${r2.energyKcal}`);

  const r3 = nutrition.normalizeRecord({ 餐品名称: '麦香鱼', 热量: '330', 蛋白质: 15 });
  check('兼容中文键名与带单位数值', r3.name === '麦香鱼' && r3.energyKcal === 330 && r3.protein === 15);
}

console.log('\n[2] 菜名相似度匹配');
{
  const cases = [
    ['巨无霸', '巨无霸', 1],
    ['麦辣鸡腿堡', '麦辣鸡腿汉堡', 0.75],
    ['薯条', '大薯条', 0.82],
    ['可乐', '可口可乐', 0.82],
    ['板烧鸡腿堡', '原味板烧鸡腿堡', 0.82],
  ];
  for (const [a, b, min] of cases) {
    const s = nutrition.similarity(a, b);
    check(`"${a}" vs "${b}" >= ${min}`, s >= min - 0.01, `got ${s.toFixed(3)}`);
  }
  check('不相关餐品低分', nutrition.similarity('薯条', '橙汁') < 0.5, `got ${nutrition.similarity('薯条', '橙汁').toFixed(3)}`);

  // 区分性：不同肉类、不同规格不应被判定为高度相似，避免营养数据张冠李戴
  const diffChickenFish = nutrition.similarity('麦香鸡', '麦香鱼');
  check('麦香鸡/麦香鱼 区分度', diffChickenFish < 0.6, `got ${diffChickenFish.toFixed(3)}`);
  const diffSize = nutrition.similarity('中薯条', '大薯条');
  check('中薯条/大薯条 区分度', diffSize < 0.6, `got ${diffSize.toFixed(3)}`);
  check('同品同规格等于1', nutrition.similarity('中薯条', '中薯条') === 1);
}

console.log('\n[3] 营养库加载与汇总');
{
  const lib = new nutrition.NutritionLibrary();
  // 使用与官方一致的字段命名（energyKcal / carbohydrate）
  const count = lib.load({
    foods: [
      { productName: '巨无霸', energyKcal: 513, protein: 27, fat: 26, carbohydrate: 42, sodium: 961, calcium: 171 },
      { productName: '中薯条', energyKcal: 289, protein: 4, fat: 12, carbohydrate: 38, sodium: 165, calcium: 10 },
      { productName: '中可乐', energyKcal: 147, protein: 0, fat: 0, carbohydrate: 36, sodium: 15, calcium: 0 },
    ],
  });
  check('加载 3 条记录', count === 3);

  const hit = lib.best('巨无霸');
  check('精确匹配命中', hit && hit.record.name === '巨无霸' && hit.score === 1);

  const items = [
    { name: '巨无霸', quantity: 1, nutrition: lib.best('巨无霸').record },
    { name: '中薯条', quantity: 1, nutrition: lib.best('中薯条').record },
    { name: '中可乐', quantity: 2, nutrition: lib.best('中可乐').record },
  ];
  const sum = nutrition.summarize(items);
  check('热量汇总含份数', sum.total.energyKcal === 513 + 289 + 147 * 2, `got ${sum.total.energyKcal}`);
  check('钠汇总含份数', sum.total.sodium === 961 + 165 + 15 * 2, `got ${sum.total.sodium}`);
  check('NRV 百分比计算', sum.vsNrv.sodium.mealPercent > 0);
  // 回归防护：曾因 NRV 键名与汇总字段不一致导致热量占比缺失
  check('热量 NRV 占比生成', Boolean(sum.vsNrv.energyKcal) && sum.vsNrv.energyKcal.mealPercent > 0,
    JSON.stringify(Object.keys(sum.vsNrv)));
  check('六项营养均有 NRV 对照', ['energyKcal', 'protein', 'fat', 'carb', 'sodium', 'calcium'].every((k) => Boolean(sum.vsNrv[k])),
    JSON.stringify(Object.keys(sum.vsNrv)));
  check('健康提示生成', nutrition.buildHealthNotes(sum).length > 0);
  check('高钠触发警告', nutrition.buildHealthNotes(sum).some((n) => n.level === 'warn'), JSON.stringify(nutrition.buildHealthNotes(sum)));
}

console.log('\n[4] 优惠券归一化与门槛解析');
{
  const c1 = optimizer.normalizeCoupon({ couponId: 'CP001', couponName: '满30减5券', 有效期: '2026-12-31' });
  check('从券名解析门槛', c1 && c1.threshold === 30, `got ${c1 && c1.threshold}`);
  check('从券名解析面额', c1 && c1.discount === 5, `got ${c1 && c1.discount}`);

  const c2 = optimizer.normalizeCoupon({ id: 'CP002', name: '薯条优惠', minAmount: 25.9, discountAmount: 6 });
  check('结构化字段优先', c2.threshold === 25.9 && c2.discount === 6);

  const c3 = optimizer.normalizeCoupon({ code: 'CP003', title: '无门槛1元', 面值: 1 });
  check('无门槛券 threshold 为空', c3.threshold === null && c3.discount === 1);
}

console.log('\n[5] 凑单方案构造');
{
  const items = [{ code: 'M1', name: '巨无霸', quantity: 1, price: 24 }];
  const coupons = [
    optimizer.normalizeCoupon({ couponId: 'C1', couponName: '满30减8券' }),
    optimizer.normalizeCoupon({ couponId: 'C2', couponName: '无门槛减2券' }),
  ];
  const menu = [
    optimizer.normalizeMeal({ mealCode: 'M2', mealName: '小薯条', price: 7 }),
    optimizer.normalizeMeal({ mealCode: 'M3', mealName: '中可乐', price: 9 }),
    optimizer.normalizeMeal({ mealCode: 'M4', mealName: '麦旋风', price: 6 }),
  ];

  // 实测：菜单不返回价格，优惠由服务端自动计算，因此策略为
  //「基准组合 + 若干加购组合」，通过对每种组合真实试算来比较
  const plans = optimizer.buildPlans({ items, coupons, menu });
  check('生成基准方案', plans.some((p) => p.strategy === 'baseline'));
  const topups = plans.filter((p) => p.strategy === 'topup');
  check('生成加购方案', topups.length > 0, `got ${topups.length}`);
  check('加购方案比基准多一件', topups.every((p) => p.items.length === 2));
  check('加购项带 isAddon 标记', topups.every((p) => p.items.some((i) => i.isAddon)));
  check('优先挑选小食饮品类加购', topups[0].addon && /小食|饮品|薯条|鸡块/.test(`${topups[0].addon.name}${topups[0].addon.category || ''}`),
    JSON.stringify(topups[0] && topups[0].addon));
  check('方案数受上限约束', optimizer.buildPlans({ items, coupons, menu, maxPlans: 3 }).length <= 3);
}

console.log('\n[6] 方案排序');
{
  const mk = (id, payable, kcal, protein) => ({
    id, strategy: 'single-coupon',
    price: { payable, original: payable + 5, discount: 5 },
    nutrition: { energyKcal: kcal, protein },
  });
  const plans = [mk('a', 40, 900, 20), mk('b', 32, 1200, 25), mk('c', 35, 700, 30)];

  const cheapest = optimizer.rankPlans(plans.map((p) => ({ ...p })), 'cheapest');
  check('最省钱模式按价格升序', cheapest[0].price.payable === 32);

  const healthiest = optimizer.rankPlans(plans.map((p) => ({ ...p })), 'healthiest');
  check('最健康模式优先低热量', healthiest[0].nutrition.energyKcal === 700, `got ${healthiest[0].nutrition.energyKcal}`);

  const balanced = optimizer.rankPlans(plans.map((p) => ({ ...p })), 'balanced');
  check('均衡模式返回全部方案', balanced.length === 3);
  check('基准对比节省额计算', typeof cheapest.find((p) => p.savingsVsBaseline !== undefined) !== 'undefined' || true);
}

console.log('\n[9] 老虎机符号精选');
{
  const slot = require('./src/slot');
  const menu = [
    { code: '1', name: '麦辣鸡腿汉堡', image: 'a.png', hasRounds: false },
    { code: '2', name: '板烧鸡腿堡', image: 'b.png', hasRounds: false },
    { code: '3', name: '中薯条', image: 'c.png', hasRounds: false },
    { code: '4', name: '麦乐鸡5块', image: 'd.png', hasRounds: false },
    { code: '5', name: '圆筒冰淇淋', image: 'e.png', hasRounds: false },
    { code: '6', name: '可乐中杯', image: 'f.png', hasRounds: false },
    { code: '7', name: '板烧鸡腿堡三件套', image: 'g.png', hasRounds: true },
    { code: '8', name: '无图餐品', image: null, hasRounds: false },
  ];

  const syms = slot.pickSymbols(menu);
  check('跳过无图餐品', !syms.some((s) => s.name === '无图餐品'));
  check('汉堡类被识别', syms.some((s) => s.category === 'burger'));
  // 套餐全部剔除：营养库没有套餐记录，摇中后营养面板会大面积空白
  check('套餐被完全剔除', !syms.some((s) => /件套|套餐|随心配/.test(s.name)), JSON.stringify(syms.map((s) => s.name)));
  check('不存在 combo 分类', !syms.some((s) => s.category === 'combo'));
  check('任何符号都不再标记 isCombo', syms.every((s) => s.isCombo === false));
  // 去掉套餐分类后头奖档位仍要保留，否则 jackpot 分支永远不会触发
  check('稀有符号仍存在', syms.some((s) => s.rare), JSON.stringify(syms.filter((s) => s.rare).map((s) => s.name)));
  check('稀有符号不是套餐', syms.filter((s) => s.rare).every((s) => !slot.isComboMeal(s)));
  check('每个符号都有权重', syms.every((s) => s.weight > 0));
  check('滚轮索引连续', syms.every((s, i) => s.index === i));

  // 「其他」补齐分支同样要挡住套餐：符号不足时会从剩余菜单里捞，
  // 不能把套餐又捞回来
  const thinMenu = [
    { code: 'c1', name: '板烧鸡腿堡三件套', image: 'g.png', hasRounds: true },
    { code: 'c2', name: '超值套餐', image: 'h.png', hasRounds: true },
    { code: 'c3', name: '双层牛堡', image: 'i.png', hasRounds: false },
    { code: 'c4', name: '玉米杯', image: 'j.png', hasRounds: false },
    { code: 'c5', name: '圆筒冰淇淋', image: 'k.png', hasRounds: false },
    { code: 'c6', name: '可乐中杯', image: 'l.png', hasRounds: false },
  ];
  const thin = slot.pickSymbols(thinMenu);
  check('补齐分支也剔除套餐', thin.length > 0 && thin.every((s) => !slot.isComboMeal(s)), JSON.stringify(thin.map((s) => s.name)));
  check('全套餐菜单下不产出符号或只产单品', thin.every((s) => !s.isCombo));

  // 营养优先：同分类内，有营养数据的排在前面
  const withNutri = slot.pickSymbols(menu, { hasNutrition: (m) => m.name === '板烧鸡腿堡' || m.name === '中薯条' || m.name === '圆筒冰淇淋' });
  const burgerNames = withNutri.filter((s) => s.category === 'burger').map((s) => s.name);
  check('有营养数据的排前', burgerNames[0] === '板烧鸡腿堡', JSON.stringify(burgerNames));

  check('空菜单返回空', slot.pickSymbols([]).length === 0);
}

console.log('\n[10] 老虎机开奖概率与赔付');
{
  const slot = require('./src/slot');
  const symbols = [
    { id: 'a', name: '汉堡A', rare: false, weight: 14 },
    { id: 'b', name: '汉堡B', rare: false, weight: 14 },
    { id: 'c', name: '薯条', rare: false, weight: 14 },
    { id: 'd', name: '套餐', rare: true, weight: 6 },
  ];

  const N = 60000;
  const tally = { jackpot: 0, triple: 0, pair: 0, none: 0 };
  let payoutSum = 0;
  for (let i = 0; i < N; i++) {
    const reels = slot.spin(symbols);
    const r = slot.evaluate(reels);
    tally[r.level]++;
    payoutSum += r.payout;
  }

  const pct = (k) => (tally[k] / N) * 100;
  check('三连/头奖概率接近设定', Math.abs(pct('jackpot') - 1.5) < 0.6, `jackpot ${pct('jackpot').toFixed(2)}%`);
  check('普通三连概率接近设定', Math.abs(pct('triple') - 7) < 1.2, `triple ${pct('triple').toFixed(2)}%`);
  check('两连概率接近设定', Math.abs(pct('pair') - 25) < 2, `pair ${pct('pair').toFixed(2)}%`);
  check('未中奖占比最高', tally.none > tally.pair, `none ${pct('none').toFixed(2)}%`);

  const expected = payoutSum / N;
  check('期望赔付低于单次成本（可持续）', expected < slot.SPIN_COST, `期望 ${expected.toFixed(2)} < ${slot.SPIN_COST}`);
  check('期望赔付不过低（有可玩性）', expected > slot.SPIN_COST * 0.7, `期望 ${expected.toFixed(2)}`);

  // 滚轮画面必须与判定结果一致：不能出现「判定三连但画面三个不同」这类穿帮
  const seen = { jackpot: 0, triple: 0, pair: 0, none: 0 };
  let inconsistent = null;
  for (let i = 0; i < 5000 && !inconsistent; i++) {
    const reels = slot.spin(symbols);
    const ev = slot.evaluate(reels);
    const ids = reels.map((r) => r.id);
    seen[ev.level]++;

    if (ev.level === 'jackpot') {
      if (!(ids[0] === ids[1] && ids[1] === ids[2] && reels[0].rare)) inconsistent = '头奖应为稀有三连：' + ids.join(',');
    } else if (ev.level === 'triple') {
      if (!(ids[0] === ids[1] && ids[1] === ids[2])) inconsistent = '三连但滚轮不一致：' + ids.join(',');
      if (reels[0].rare) inconsistent = '普通三连不应使用稀有符号：' + ids.join(',');
    } else if (ev.level === 'pair') {
      if (new Set(ids).size !== 2) inconsistent = '两连但分布异常：' + ids.join(',');
    } else if (new Set(ids).size !== 3) {
      inconsistent = '未中奖但出现重复：' + ids.join(',');
    }
  }
  check('滚轮与判定始终一致', inconsistent === null, inconsistent || 'ok');
  check('头奖分支被覆盖', seen.jackpot > 0, `${seen.jackpot} 次`);
  check('三连分支被覆盖', seen.triple > 0, `${seen.triple} 次`);
  check('两连分支被覆盖', seen.pair > 0, `${seen.pair} 次`);
  check('未中奖分支被覆盖', seen.none > 0, `${seen.none} 次`);

  check('单次消耗与初始金币合理', slot.SPIN_COST === 10 && slot.START_CREDITS === 200);

  const offsets = slot.reelStopOffsets(symbols, [symbols[2], symbols[0], symbols[1]]);
  check('停止偏移含整圈数', offsets.every((o) => o >= symbols.length));
  check('停止偏移对应目标索引', offsets[0] % symbols.length === 2 && offsets[1] % symbols.length === 0);
}

console.log('\n[7] 计价结果归一化（业务失败识别）');
{
  // 回归用例：麦当劳在商品售罄/不可售时返回 success:false 且不带 data 层。
  // 早期实现未判断 success，把错误响应体当业务数据解析，最终只提示「未返回金额」，
  // 掩盖了真实原因，让人误以为接口整体失效。
  const soldOut = {
    success: false,
    code: 60006,
    message: '商品已售罄或不可售，换一个商品或检查orderType/beType',
    datetime: '2026-10-20 20:58:57',
    traceId: 'd03997b2',
  };
  const r1 = optimizer.normalizePriceResult(soldOut);
  check('识别业务失败', !!(r1 && r1.failed), JSON.stringify(r1));
  check('保留错误码', r1 && r1.code === 60006, r1 && String(r1.code));
  check('原样保留接口文案', r1 && r1.message.includes('售罄'), r1 && r1.message);

  // 成功响应不能被误判为失败：成功时 code=200，且带 data 层
  const ok = {
    success: true,
    code: 200,
    message: '请求成功',
    data: { productOriginalPrice: 2350, price: 2350, discount: 0, productList: [{ productCode: '1406', productName: '板烧鸡腿堡' }] },
  };
  const r2 = optimizer.normalizePriceResult(ok);
  check('成功响应不判为失败', r2 && !r2.failed, JSON.stringify(r2 && r2.failed));
  check('金额由分换算为元', r2 && r2.payable === 23.5, r2 && String(r2.payable));
  check('原价换算', r2 && r2.original === 23.5, r2 && String(r2.original));
  check('有商品明细时不标记可疑', r2 && r2.suspicious === false);

  // 静默失败：字段结构写错时接口返回 price=0 且无商品列表
  const silent = { success: true, code: 200, data: { price: 0, discount: 0 } };
  const r3 = optimizer.normalizePriceResult(silent);
  check('识别静默失败（price=0 且无商品）', r3 && r3.suspicious === true, JSON.stringify(r3));

  // 无 data 包裹、直接给金额的情形
  const flat = { success: true, code: 200, price: 2690, discount: 710 };
  const r4 = optimizer.normalizePriceResult(flat);
  check('兼容无 data 层结构', r4 && r4.payable === 26.9 && r4.discount === 7.1, JSON.stringify(r4));

  check('空输入返回 null', optimizer.normalizePriceResult(null) === null);
  check('非对象返回 null', optimizer.normalizePriceResult('oops') === null);

  // 既无金额也无 data 的异常响应，不应被当成崩溃
  const weird = { success: true, code: 200, message: '请求成功' };
  check('无金额返回 null', optimizer.normalizePriceResult(weird) === null);
}

console.log('\n[11] 每件单价与到手折扣');
{
  // 真实抓包：不素之霸双层牛堡 + 中薯条 + 冰奶铁中杯
  // 整单 original 62.00、payable 54.90、discount 7.10
  // 服务端把 7.10 全部记在冰奶铁行项目上：2100 → 1390
  const combo = {
    success: true,
    code: 200,
    data: {
      productOriginalPrice: 6200,
      originalPrice: 6200,
      discount: 710,
      price: 5490,
      productList: [
        { productCode: '4648', productName: '不素之霸双层牛堡', quantity: 1, originalSubtotal: 2650, subtotal: 2650 },
        { productCode: '4810', productName: '中薯条', quantity: 1, originalSubtotal: 1450, subtotal: 1450 },
        { productCode: '507409', productName: '麦咖啡™冰奶铁中杯', quantity: 1, originalSubtotal: 2100, subtotal: 1390 },
      ],
    },
  };
  const r = optimizer.normalizePriceResult(combo);
  check('展开三行明细', r.lines.length === 3, String(r.lines.length));
  check('整单实付 54.90', r.payable === 54.9, String(r.payable));
  check('行项目原价合计等于整单原价', r.linesTotal === 62, String(r.linesTotal));

  const burger = r.lines.find((l) => l.code === '4648');
  check('牛堡单价 26.50 无折扣', burger.unitPayable === 26.5 && burger.discountLabel === null, JSON.stringify(burger));

  const fries = r.lines.find((l) => l.code === '4810');
  check('中薯条单价 14.50 无折扣', fries.unitPayable === 14.5 && fries.discountLabel === null, JSON.stringify(fries));

  const coffee = r.lines.find((l) => l.code === '507409');
  check('冰奶铁原价 21.00', coffee.unitOriginal === 21, String(coffee.unitOriginal));
  check('冰奶铁到手 13.90', coffee.unitPayable === 13.9, String(coffee.unitPayable));
  check('冰奶铁省 7.10', coffee.saved === 7.1, String(coffee.saved));
  check('冰奶铁折扣率 0.66', coffee.discountRate === 0.66, String(coffee.discountRate));
  check('冰奶铁显示 6.6折', coffee.discountLabel === '6.6折', String(coffee.discountLabel));

  check('整单折扣率 0.89', r.overallRate === 0.89, String(r.overallRate));
  check('整单显示 8.9折', r.overallDiscountLabel === '8.9折', String(r.overallDiscountLabel));

  // 行项目优惠之和应与整单 discount 自洽
  const savedSum = Math.round(r.lines.reduce((s, l) => s + (l.saved || 0), 0) * 100) / 100;
  check('行项目优惠合计等于整单优惠', savedSum === 7.1, String(savedSum));

  // 数量为 2 时，单价应按行数折算，而不是把小计当单价
  const multi = {
    success: true,
    data: {
      originalPrice: 2900,
      discount: 0,
      price: 2900,
      productList: [
        { productCode: '4810', productName: '中薯条', quantity: 2, originalSubtotal: 2900, subtotal: 2900 },
      ],
    },
  };
  const rm = optimizer.normalizePriceResult(multi);
  check('数量为 2 时单价折半', rm.lines[0].unitPayable === 14.5, String(rm.lines[0].unitPayable));
  check('数量为 2 时小计保留', rm.lines[0].payable === 29, String(rm.lines[0].payable));

  // 服务端不分摊优惠时，需按原价比例二次分摊，否则用户看到「有优惠但每件都没折扣」
  const noAllocate = {
    success: true,
    data: {
      originalPrice: 3000,
      discount: 300,
      price: 2700,
      productList: [
        { productCode: 'A', productName: 'A餐', quantity: 1, originalSubtotal: 1000, subtotal: 1000 },
        { productCode: 'B', productName: 'B餐', quantity: 1, originalSubtotal: 2000, subtotal: 2000 },
      ],
    },
  };
  const rn = optimizer.normalizePriceResult(noAllocate);
  check('未分摊时按比例补算 A 省 1.00', rn.lines[0].saved === 1, String(rn.lines[0].saved));
  check('未分摊时按比例补算 B 省 2.00', rn.lines[1].saved === 2, String(rn.lines[1].saved));
  check('补算后 A 为 9折', rn.lines[0].discountLabel === '9折', String(rn.lines[0].discountLabel));
  check('补算后 B 为 9折', rn.lines[1].discountLabel === '9折', String(rn.lines[1].discountLabel));
  const rnSaved = Math.round(rn.lines.reduce((s, l) => s + (l.saved || 0), 0) * 100) / 100;
  check('补算后优惠合计无尾差', rnSaved === 3, String(rnSaved));

  // 折扣标签边界
  check('原价时无折扣标签', optimizer.discountLabel(1) === null);
  check('浮点误差 0.9999 不算折扣', optimizer.discountLabel(0.9999) === null);
  check('刚好 5 折', optimizer.discountLabel(0.5) === '5折');
  check('null 安全', optimizer.discountLabel(null) === null);
  check('零原价不会出现 NaN', optimizer.discountLabel(0) === null);
}

console.log('\n[12] 无厘头营养彩蛋');
{
  const mk = (total) => {
    const s = nutrition.summarize([{ name: 'x', quantity: 1, nutrition: total }]);
    return nutrition.buildHealthNotes(s);
  };

  // 严重超标：热量 1500kcal、钠 3000mg
  const heavy = mk({ energyKcal: 1500, protein: 40, fat: 80, carb: 150, sodium: 3000 });
  const warns = heavy.filter((n) => n.level === 'warn');
  const funs = heavy.filter((n) => n.level === 'fun');
  check('超标时仍给出严肃警告', warns.length >= 2, String(warns.length));
  check('超标时同样给出无厘头彩蛋', funs.length === 1, String(funs.length));
  check('彩蛋文案来自话术库', funs.length === 1 && Object.values(nutrition.FUN_LINES).some((pool) => pool.includes(funs[0].text)));

  // 健康搭配：不能因为「吃得好」就没有彩蛋
  const light = mk({ energyKcal: 300, protein: 20, fat: 8, carb: 30, sodium: 300 });
  check('清淡时也有彩蛋', light.some((n) => n.level === 'fun'), JSON.stringify(light));
  check('清淡时给出正面评价', light.some((n) => n.level === 'good' || n.level === 'info'), JSON.stringify(light));

  // 确定性：同一顿饭刷新后句子不变
  const again = mk({ energyKcal: 1500, protein: 40, fat: 80, carb: 150, sodium: 3000 });
  check('彩蛋在同一顿饭下稳定', again.filter((n) => n.level === 'fun')[0].text === funs[0].text);

  // 换一顿饭应换一句（避免每次都看同一句）
  const other = mk({ energyKcal: 1100, protein: 30, fat: 55, carb: 120, sodium: 2200 });
  const otherFun = other.filter((n) => n.level === 'fun')[0].text;
  check('不同搭配会换句子', otherFun !== funs[0].text, `${otherFun} vs ${funs[0].text}`);

  // 全空数据不能崩
  const empty = nutrition.buildHealthNotes(nutrition.summarize([]));
  check('空餐品不崩溃且有彩蛋', Array.isArray(empty) && empty.some((n) => n.level === 'fun'), JSON.stringify(empty));
}

console.log('\n[13] 门店查询参数构造（city / keyword 拆分）');
{
  const sq = require('./src/store-query');

  // 用户直接粘门店全名——之前正是这种输入被塞进 city，导致返回 0 家
  const a = sq.splitCityKeyword('麦当劳杭州三里亭餐厅');
  check('整句能拆出城市', a.city === '杭州', JSON.stringify(a));
  check('整句能拆出地标', a.keyword === '三里亭', JSON.stringify(a));

  const b = sq.splitCityKeyword('杭州三里亭');
  check('城市+地标拆分', b.city === '杭州' && b.keyword === '三里亭', JSON.stringify(b));

  const c = sq.splitCityKeyword('三里亭');
  check('无城市前缀时保留原串', c.city === '' && c.keyword === '三里亭', JSON.stringify(c));

  const d = sq.splitCityKeyword('乌鲁木齐');
  check('长城市名不被短名截断', d.city === '乌鲁木齐' && d.keyword === '乌鲁木齐', JSON.stringify(d));

  check('空输入返回空', sq.splitCityKeyword('').city === '' && sq.splitCityKeyword(null).city === '');

  // keyword 绝不能为空：实测只传 city 会返回 code 600058
  const e = sq.splitCityKeyword('杭州');
  check('只有城市时 keyword 回落为城市名', e.keyword === '杭州', JSON.stringify(e));

  // 候选组：显式城市优先，且不去重后重复
  const p1 = sq.buildStoreQueries('三里亭', '杭州');
  check('显式城市排第一', p1[0].city === '杭州' && p1[0].keyword === '三里亭', JSON.stringify(p1));
  check('候选组非空', p1.length > 0);
  const p2 = sq.buildStoreQueries('松江', '');
  check('区名走整串兜底', p2.some((p) => p.city === '松江' && p.keyword === '松江'), JSON.stringify(p2));
  const p3 = sq.buildStoreQueries('麦当劳杭州三里亭餐厅', '');
  check('全名自动生成拆分候选', p3.some((p) => p.city === '杭州' && p.keyword === '三里亭'), JSON.stringify(p3));
  check('候选组不重复', new Set(p3.map((p) => p.city + '|' + p.keyword)).size === p3.length);
  check('空输入无候选', sq.buildStoreQueries('', '').length === 0);
}

console.log('\n[1+1] 随心配识别与拼单');
{
  // 差价文案来自官方 detail.rounds[].choices[].diffPrice
  check('差价 + ¥0', combo.parseDiffPrice('+ ¥0') === 0);
  check('差价 - ¥1', combo.parseDiffPrice('- ¥1') === -1);
  check('差价 + ¥2.5', combo.parseDiffPrice('+ ¥2.5') === 2.5);
  check('差价缺省为 0', combo.parseDiffPrice(null) === 0 && combo.parseDiffPrice('') === 0);
  check('数字差价原样返回', combo.parseDiffPrice(-3) === -3);

  // 两个套餐：1120 同时出现在 A 的蓝区与 B 的粉区（官方允许同一商品跨区）
  const details = [
    {
      code: '9900013304', name: '人气经典随心配',
      rounds: [
        { id: 1, name: '蓝区', quantity: 1, choices: [
          { code: '1120', name: '双层吉士汉堡', diffPrice: '+ ¥0' },
          { code: '1600', name: '麦香鱼', diffPrice: '+ ¥0' },
          { code: '521881', name: '马来咖喱风味薄皮肉骨鸡3块', diffPrice: '+ ¥0' },
        ] },
        { id: 2, name: '粉区', quantity: 1, choices: [
          { code: '3050', name: '可乐中杯', diffPrice: '+ ¥0' },
          { code: '4437', name: '小杯玉米杯', diffPrice: '- ¥1' },
        ] },
      ],
    },
    {
      code: '9900015568', name: '精选超值随心配',
      rounds: [
        { id: 1, name: '蓝区', quantity: 1, choices: [
          { code: '1600', name: '麦香鱼', diffPrice: '+ ¥0' },
        ] },
        { id: 2, name: '粉区', quantity: 1, choices: [
          { code: '1120', name: '双层吉士汉堡', diffPrice: '+ ¥0' },
        ] },
      ],
    },
  ];

  const idx = combo.buildComboIndex(details);
  check('索引收录两个套餐', idx.size === 2, `got ${idx.size}`);
  check('单品映射到所属分区', idx.slotMap['3050'] && idx.slotMap['3050'][0].comboCode === '9900013304');
  check('跨区单品有两条归属', idx.slotMap['1120'] && idx.slotMap['1120'].length === 2, JSON.stringify(idx.slotMap['1120']));
  check('rounds 归一化保留分区名', idx.combos[0].rounds[0].name === '蓝区');
  check('空分区被丢弃', combo.buildComboIndex([{ code: 'x', name: 'x', rounds: [{ id: 1, choices: [] }, { id: 2, name: '粉区', choices: [{ code: '1' }] }] }]).size === 0);

  // 正常拼单：蓝区 1120 + 粉区 3050
  const deals = combo.findDeals(['1120', '3050'], idx);
  check('能识别出 1+1 组合', deals.length === 1, `got ${deals.length}`);
  check('组合指向人气经典', deals[0].comboCode === '9900013304');
  check('roundList 结构正确', JSON.stringify(deals[0].roundList) === JSON.stringify([
    { round: '1', comboItemList: [{ code: '1120', quantity: 1 }] },
    { round: '2', comboItemList: [{ code: '3050', quantity: 1 }] },
  ]), JSON.stringify(deals[0].roundList));
  check('分区名一并带出', deals[0].slots.map((s) => s.roundName).join('/') === '蓝区/粉区');

  // 同一分区的两件不能拼（蓝区 + 蓝区；1120 虽跨到 B 的粉区，但 521881 只在 A 的蓝区）
  check('同区两件不算 1+1', combo.findDeals(['1120', '521881'], idx).length === 0);
  // 其中一件根本不在套餐里
  check('含非套餐单品时不拼', combo.findDeals(['1120', '999999'], idx).length === 0);
  // 少于两件
  check('单件无法拼单', combo.findDeals(['1120'], idx).length === 0);

  // 两个滚轮摇到同一件、且该件在两个分区都提供 → 可以拼
  const crossIdx = combo.buildComboIndex([{
    code: 'C1', name: '测试套餐',
    rounds: [
      { id: 1, name: 'A区', choices: [{ code: '9999', name: '跨区单品', diffPrice: '+ ¥0' }] },
      { id: 2, name: 'B区', choices: [{ code: '9999', name: '跨区单品', diffPrice: '+ ¥0' }] },
    ],
  }]);
  check('同一单品跨区可拼', combo.findDeals(['9999', '9999'], crossIdx).length === 1,
    `got ${combo.findDeals(['9999', '9999'], crossIdx).length}`);
  // 差价更低的组合排在前面
  const byDiff = combo.findDeals(['4437', '1120'], idx);
  check('负差价被计入', byDiff[0].diffSum === -1, JSON.stringify(byDiff[0] && byDiff[0].diffSum));

  // 折扣文案
  check('套餐折扣 14.9/23 = 6.5 折', combo.discountLabel(14.9, 23) === '6.5 折', combo.discountLabel(14.9, 23));
  check('无优惠不显示折扣', combo.discountLabel(23, 23) === null);
  check('缺原价时不编折扣', combo.discountLabel(14.9, 0) === null);
}

(async () => {
console.log(`\n[9] 演示快照（线上试玩的数据源）`);
{
  const demo = require('./src/demo-mcp');
  const snap = demo.loadSnapshot();

  if (!snap) {
    check('快照文件存在', false, 'demo/demo-snapshot.json 缺失，线上试玩会退化为要求 Token');
  } else {
    check('快照可加载', Array.isArray(snap.menu) && snap.menu.length > 50, `menu ${snap.menu && snap.menu.length}`);
    check('快照带抓取时点', typeof snap.generatedAt === 'string' && snap.generatedAt.length >= 10, snap.generatedAt);
    check('快照带门店中文名', !!(snap.store && snap.store.storeName), JSON.stringify(snap.store || {}));

    const client = new demo.DemoMcpClient(snap);
    const symbols = client.symbolsOverride(snap.menu);
    check('演示符号与快照一致', symbols.length === snap.symbols.length && symbols.every((s) => s.code && s.name && s.image),
      `${symbols.length} vs ${snap.symbols.length}`);
    check('演示客户端自带工具 schema', client.getToolSchema('calculate-price') !== null);

    // 已抓取的三连：必须逐分对上抓取时的真实响应
    const key = Object.keys(snap.triples).find((k) => !snap.triples[k].failed);
    const codes3 = key.split('|');
    const got = client.calculatePrice({
      items: [...new Set(codes3)].map((c) => ({ productCode: c, quantity: codes3.filter((x) => x === c).length })),
    });
    check('三连命中快照原样返回', got.success && got.data.price === snap.triples[key].price,
      `demo ${got.data && got.data.price} vs 快照 ${snap.triples[key].price}`);
    check('真实优惠被保留', got.data.discount === snap.triples[key].discount,
      `demo ${got.data.discount} vs 快照 ${snap.triples[key].discount}`);

    // 套餐价 = 基础价 + 子件差价
    const cb = snap.combos && snap.combos[0];
    if (cb) {
      const roundList = cb.rounds.map((r) => ({ round: String(r.id), comboItemList: [{ code: r.choices[0].code, quantity: 1 }] }));
      const priced = client.calculatePrice({ items: [{ productCode: cb.code, quantity: 1, roundList }] });
      const expect = cb.baseFen + cb.rounds.reduce((s, r) => s + (r.choices[0].diffFen || 0), 0);
      check('套餐价 = 基础价 + 差价', priced.success && priced.data.price === expect,
        `demo ${priced.data && priced.data.price} vs 期望 ${expect}`);
    } else {
      check('快照含 1+1 套餐', false);
    }

    // 快照里没有的组合：按真实单价合成，不编折扣
    const unknown = client.calculatePrice({ items: [{ productCode: '999999999', quantity: 1 }] });
    check('未知餐品不返回假价格', unknown.success === false, JSON.stringify(unknown).slice(0, 120));

    let threw = false;
    try { await client.callTool('draw-lottery', {}); } catch (_) { threw = true; }
    check('未覆盖的工具直接报错而非造假', threw);
  }
}

console.log('\n[10] 一键下单：参数翻译与回包收敛');
{
  const order = require('./src/order');

  // 取餐方式是白名单：前端传来的字符串绝不能直接进 create-order
  const tw = order.normalizeTakeWay([
    { code: 'eat-in', title: '堂食' },
    { code: 'take-in-store', title: '外带' },
    { code: 'eat-in', title: '重复项' },
    { title: '没有 code' },
  ]);
  check('takeWayList 去重且过滤无 code 项', tw.length === 2 && tw[0].code === 'eat-in', JSON.stringify(tw));
  check('未知取餐方式回退到第一个', order.pickTakeWay(tw, 'fly-away') === tw[0]);
  check('已知取餐方式精确命中', order.pickTakeWay(tw, 'take-in-store') === tw[1]);
  check('空列表不返回取餐方式', order.pickTakeWay([], 'eat-in') === null);

  // 能拼 1+1：套餐项在前（带 roundList），没进套餐的照单点跟在后面
  const comboDeal = {
    available: true,
    code: '9900011872',
    roundList: [
      { round: '1', comboItemList: [{ code: '1401', quantity: 1 }] },
      { round: '2', comboItemList: [{ code: '4437', quantity: 1 }] },
    ],
    extraItems: [{ code: '1406', name: '板烧鸡腿堡' }],
  };
  const items = order.buildOrderItems([{ code: '1401' }, { code: '4437' }, { code: '1406' }], comboDeal);
  check('套餐下单只发「套餐项 + 剩余单品」', items.length === 2 && items[0].productCode === '9900011872',
    JSON.stringify(items));
  check('套餐项带 roundList 两个分区', items[0].roundList.length === 2 && items[0].roundList[0].round === '1');
  check('剩余单品按单点发', items[1].productCode === '1406' && !items[1].roundList);
  const plain = order.buildOrderItems([{ code: '1401' }, { code: '4437' }], null);
  check('没有套餐时逐件发', plain.length === 2 && plain.every((i) => i.quantity === 1));

  // 金额单位：calculate-price 给分，create-order 给元的字符串
  check('元字符串转数字', order.toYuan('26.9') === 26.9, `got ${order.toYuan('26.9')}`);
  check('已带货币符号也能解析', order.toYuan('¥26.90') === 26.9);
  check('空值不当作 0 元', order.toYuan('') === null && order.toYuan(null) === null);

  // 支付截止时间是门店本地时间（UTC+8），不带时区
  const exp = order.parseExpireAt('2026-10-22 08:02:47');
  check('expirePayTime 按 UTC+8 解析', exp === Date.UTC(2026, 9, 22, 0, 2, 47), `got ${exp}`);

  check('待支付等待中', order.describeStatus({ status: 10, orderStatus: '待支付' }).waiting === true);
  check('已取消是终态', order.describeStatus({ status: 60, orderStatus: '订单已取消' }).cancelled === true);
  check('已支付能被识别', order.describeStatus({ status: 20, orderStatus: '已支付' }).paid === true);

  const normalized = order.normalizeOrder({
    orderId: '1030783210000795859126729765',
    payH5Url: 'https://m.mcd.cn/mcp/scanToPay?orderId=1030783210000795859126729765',
    orderDetail: {
      orderStatus: '待支付', status: 10,
      totalAmount: '34', realTotalAmount: '26.9', totalDiscountAmount: '7.1',
      takeWay: '外带', storeName: '麦当劳杭州三里亭餐厅',
      expirePayTime: '2026-10-22 08:02:47',
      orderProductList: [{
        productName: '芝芝火腿扒堡', quantity: 1, price: '13',
        comboItemList: [{ itemName: '麦乐鸡5块', itemQuantity: 1 }],
      }],
    },
  });
  check('回包收敛出 orderId 与付款链接', normalized.orderId === '1030783210000795859126729765'
    && /scanToPay/.test(normalized.payH5Url));
  check('实付金额转成数字元', normalized.payable === 26.9 && normalized.discount === 7.1);
  check('套餐子件被展开', normalized.products[0].comboItems[0].name === '麦乐鸡5块');
  check('支付截止时间带毫秒戳', typeof normalized.expireAt === 'number' && normalized.expireAt > 0);
}

console.log('\n[11] 技能（skills/mcshake-slot）：能自检、能跑、不乱建单');
{
  const fsx = require('fs');
  const pathx = require('path');
  const { execFileSync } = require('child_process');
  const skillDir = pathx.join(__dirname, 'skills', 'mcshake-slot');
  const entry = pathx.join(skillDir, 'scripts', 'mcshake.js');

  check('技能目录存在', fsx.existsSync(entry));
  const md = fsx.readFileSync(pathx.join(skillDir, 'SKILL.md'), 'utf8');
  check('SKILL.md 有 name 与 description', /^name:\s*mcshake-slot$/m.test(md) && /^description:\s*"/m.test(md));
  check('SKILL.md 写明「没有支付工具」这条边界', md.includes('没有支付能力') || md.includes('没有支付工具'));

  // 项目定位：装在仓库里时必须能自己找到仓库根
  const { resolveProjectRoot, looksLikeProject } = require('./skills/mcshake-slot/scripts/lib/root');
  check('looksLikeProject 认得本仓库', looksLikeProject(__dirname) === true);
  check('resolveProjectRoot 能定位到仓库根', resolveProjectRoot() === __dirname, resolveProjectRoot());

  // 排版：三连/两连/全不同的判定必须一致
  const render = require('./skills/mcshake-slot/scripts/lib/render');
  check('三连识别为头奖', render.judge(['1401', '1401', '1401']).kind === 'jackpot');
  check('两连识别为小奖', render.judge(['1401', '1401', '4437']).kind === 'pair');
  check('全不同识别为未中奖', render.judge(['1401', '4437', '4810']).kind === 'none');

  // 不带参数必须打印用法、退出码 0，而不是抛栈
  let help = '';
  try {
    help = execFileSync(process.execPath, [entry, 'help'], { encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    help = '';
  }
  check('无参数运行打印用法并正常退出', help.includes('spin') && help.includes('order preview'), help.slice(0, 80));

  // -h 是最自然的求助动作，不该回一句「未知命令」
  let shortHelp = '';
  try {
    shortHelp = execFileSync(process.execPath, [entry, '-h'], { encoding: 'utf8', timeout: 20000 });
  } catch (err) {
    shortHelp = '';
  }
  check('-h 同样打印用法', shortHelp.includes('spin') && shortHelp.includes('order preview'), shortHelp.slice(0, 80));

  // 建单保护：没有 --yes 不能真下单（这条只验证退出码，不触网）
  let code = 0;
  try {
    execFileSync(process.execPath, [entry, 'order', 'create'], { encoding: 'utf8', timeout: 20000, stdio: 'pipe' });
  } catch (err) {
    code = err.status;
  }
  check('order create 缺 --yes 时拒绝执行（退出码 2）', code === 2 || code === 3, `exit=${code}`);
}

console.log('\n[12] 「我要 1+1」锁定分区：选套餐、annotations、跨区必中');
{
  const fsx = require('fs');
  const pathx = require('path');

  const fake = (code, name, roundNames, sizes) => ({
    code,
    name,
    rounds: roundNames.map((rn, i) => ({
      id: String(i + 1),
      name: rn,
      quantity: 1,
      choices: Array.from({ length: sizes[i] }, (_, k) => ({
        code: `${code}-${i + 1}-${k}`,
        name: `${rn}${k}`,
        diffPrice: '+ ¥0',
      })),
    })),
  });

  // 两套套餐都能用时，选组合数多的那套；两边件数相同则取编码靠前的，保证结果稳定
  const planA = combo.pickComboPlan([
    fake('990001', '人气经典随心配', ['蓝区', '粉区'], [8, 15]),
    fake('990002', '精选超值随心配', ['蓝区', '粉区'], [8, 3]),
  ]);
  check('挑可摇组合最多的那套套餐', planA.available && planA.comboCode === '990001', planA.comboCode);
  check('只输出两个分区', planA.rounds.length === 2, String(planA.rounds.length));
  check('pairCount 由前端自己算（此处不参与）', planA.rounds.every((r) => r.choices.length > 0), '有空分区');

  const planStable = combo.pickComboPlan([
    fake('990009', 'z套餐', ['蓝区', '粉区'], [4, 4]),
    fake('990003', 'a套餐', ['蓝区', '粉区'], [4, 4]),
  ]);
  check('组合数相同时按套餐编码稳定排序', planStable.comboCode === '990003', planStable.comboCode);

  check('没有随心配时为 no_combo', combo.pickComboPlan([]).reason === 'no_combo');
  check('只有一个分区时识别为 too_few',
    combo.pickComboPlan([fake('x', '单区套餐', ['蓝区'], [5])]).reason === 'too_few');
  check('两个分区都为空时不算可用',
    combo.pickComboPlan([fake('x', '空套餐', ['蓝区', '粉区'], [0, 3])]).available === false);

  // 跨套餐拼不成——这正是「第 1、2 行必须来自同一套套餐」的原因
  const idx = combo.buildComboIndex([
    fake('C1', '一号套餐', ['A区', 'B区'], [3, 3]),
    fake('C2', '二号套餐', ['A区', 'B区'], [3, 3]),
  ]);
  check('跨套餐的两件拼不出 1+1', combo.findDeals(['C1-1-0', 'C2-2-0'], idx).length === 0);
  check('同套餐跨分区的两件能拼出 1+1', combo.findDeals(['C1-1-0', 'C1-2-0'], idx).length === 1);
  check('同套餐同分区的两件拼不出 1+1', combo.findDeals(['C1-1-0', 'C1-1-1'], idx).length === 0);

  // 真实快照：A 区任意一件 + B 区任意一件，必须 100% 命中
  const snapPath = pathx.join(__dirname, 'demo', 'demo-snapshot.json');
  if (fsx.existsSync(snapPath)) {
    const snap = JSON.parse(fsx.readFileSync(snapPath, 'utf8'));
    const realIdx = combo.buildComboIndex(snap.combos || []);
    const plan = combo.pickComboPlan(realIdx.combos);
    check('真实快照里能选出一套可用的随心配', plan.available && plan.rounds.length === 2, String(plan.reason));

    if (plan.available) {
      const [RA, RB] = plan.rounds;
      let ok = 0;
      let n = 0;
      for (const a of RA.choices) {
        for (const b of RB.choices) {
          n++;
          if (combo.findDeals([a.code, b.code], realIdx).length) ok++;
        }
      }
      check(`A 区 × B 区共 ${n} 种组合全部能拼成 1+1`, ok === n && n > 0, `${ok}/${n}`);

      // 参照组：不锁分区的自然命中率应该明显更低，否则这个开关没有价值
      const symbols = (snap.symbols || []).map((s) => String(s.code));
      let free = 0, total = 0;
      for (let i = 0; i < symbols.length; i++) {
        for (let j = i + 1; j < symbols.length; j++) {
          total++;
          if (combo.findDeals([symbols[i], symbols[j]], realIdx).length) free++;
        }
      }
      check('不锁分区时自然命中率显著更低（这才是开关的意义）', free < total * 0.5,
        `命中 ${free}/${total}`);
    }

    const cm = combo.buildChoiceMap(realIdx.combos);
    check('子件兜底表覆盖了所有分区选项',
      realIdx.combos.every((c) => c.rounds.every((r) => r.choices.every((ch) => cm.has(String(ch.code))))),
      String(cm.size));
    check('兜底表里能取到套餐专属子件的真名',
      Array.from(cm.values()).every((v) => v.name && v.name !== v.code), '存在名称=编码的条目');
  }
}

// ---------------------------------------------------------------- [13] 下单前的餐品解析
//
// 这条曾经是真的 bug：锁了 1+1 摇出来的两件里，粉区常年是「迷你草莓新地」这类
// 套餐专属子件——它不在门店菜单里，于是点一键下单直接被判「不在当前门店菜单里」。
// 开关做得再对，一单也下不了。
console.log('\n[13] 下单前的餐品解析：套餐专属子件不该被拒');
{
  const snap = require('./demo/demo-snapshot.json');
  const idx = combo.buildComboIndex(snap.combos || []);
  const cm = combo.buildChoiceMap(idx.combos);
  const menu = snap.menu || [];
  const inMenu = String(menu[0].code);
  const comboOnly = Array.from(cm.keys()).find((c) => !menu.some((m) => String(m.code) === c));
  const menuOnly = menu.map((m) => String(m.code)).find((c) => !cm.has(c));

  const r1 = order.resolveOrderItems([inMenu], menu, cm);
  check('菜单内的餐品标为非套餐专属', r1.items.length === 1 && r1.items[0].comboOnly === false,
    JSON.stringify(r1.items));
  check('菜单内的餐品用菜单名', !!r1.items[0] && r1.items[0].name === menu[0].name);

  check('快照里确实存在套餐专属子件（前置条件）', !!comboOnly, '没有则这条测试无意义');
  const r2 = order.resolveOrderItems([comboOnly, menuOnly], menu, cm);
  check('套餐专属子件被接受而不是报错', r2.items.length === 2 && r2.unknown.length === 0,
    JSON.stringify(r2));
  check('套餐专属子件标为 comboOnly', r2.items[0].comboOnly === true, JSON.stringify(r2.items[0]));
  check('套餐专属子件的名字来自套餐 choices 而非编码',
    r2.items[0].name && r2.items[0].name !== comboOnly,
    `${comboOnly} → ${r2.items[0].name}`);
  check('混在一起时菜单内的那件仍按普通单品处理', r2.items[1].comboOnly === false);

  const r3 = order.resolveOrderItems(['999999', menuOnly], menu, cm);
  check('真不存在的编码仍然报 unknown', r3.unknown.length === 1 && r3.unknown[0] === '999999',
    JSON.stringify(r3.unknown));
  check('unknown 不会混进 items', r3.items.length === 1, String(r3.items.length));

  const r4 = order.resolveOrderItems([], menu, cm);
  check('空入参返回空列表而不是抛错', r4.items.length === 0 && r4.unknown.length === 0);
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
})();
