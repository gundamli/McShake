/**
 * 终端排版。目标不是做得好看，是让对话里的那一屏能直接读完：
 * 多少钱、多少卡、能不能拼 1+1、这单有没有坑，四件事必须一眼看到。
 */
const W = 46;

function money(n) {
  return n == null ? '--' : Number(n).toFixed(2);
}

function pad(s, width) {
  // 中文按两个字符宽度算，否则表格必歪
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? 2 : 1;
  if (w >= width) return String(s);
  return String(s) + ' '.repeat(width - w);
}

/** 超宽的名字会顶掉后面的列，先截断再补齐（「原味板烧鸡腿炒双蛋堡」这种就是 20 宽） */
function clip(s, width) {
  const str = String(s);
  let w = 0;
  let out = '';
  for (const ch of str) {
    const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
    if (w + cw > width) break;
    w += cw;
    out += ch;
  }
  return { text: out, truncated: out.length < str.length };
}

function padClip(s, width) {
  const c = clip(s, width);
  return pad(c.truncated ? c.text.slice(0, -1) + '…' : c.text, width);
}

function line(char = '-') {
  return '  ' + char.repeat(W);
}

function bar(percent, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return '[' + '#'.repeat(filled) + '.'.repeat(width - filled) + ']';
}

/** 三连 / 两连 / 全不同，与网页上的判定保持一致 */
function judge(codes) {
  const uniq = new Set(codes);
  if (uniq.size === 1) return { kind: 'jackpot', text: '三连！三个一模一样，这局算是摇出花了' };
  if (uniq.size === 2) return { kind: 'pair', text: '两件相同，小奖到手' };
  return { kind: 'none', text: '三件互不相同 —— 没中奖，但这餐照样能吃' };
}

function renderSpin(result, ctx = {}) {
  const out = [];
  const store = (result.storeInfo && result.storeInfo.name) || ctx.storeName || '未知门店';
  const demoTag = ctx.demo ? '演示快照（官方真实数据，非实时）' : '实时接口';

  out.push('');
  out.push(`  麦摇摇 McShake · ${store}`);
  out.push(`  ${demoTag}${ctx.snapshotAt ? ' · 抓于 ' + ctx.snapshotAt : ''}`);
  out.push(line('='));

  // 滚轮
  out.push('  滚轮停位');
  // 符号接口的 unitPrice 来自可售性预检，演示模式没做过预检就会是 null；
  // 这时用整单计价里的逐件单价兜底，别让用户看到一堆「未标价」
  const unitByCode = new Map();
  for (const l of (result.price && result.price.lines) || []) {
    if (l.unitPayable != null) unitByCode.set(String(l.code), l.unitPayable);
  }
  for (const it of result.items || []) {
    const unitPrice = it.unitPrice != null ? it.unitPrice : unitByCode.get(String(it.code));
    const unit = unitPrice != null ? `¥${money(unitPrice)}` : '未标价';
    const kcal = it.nutrition && it.nutrition.energyKcal != null ? `${it.nutrition.energyKcal} kcal` : '无营养数据';
    out.push(`    ${padClip(it.name, 22)}${pad(unit, 11)}${kcal}`);
  }
  const codes = (result.items || []).map((i) => i.code);
  out.push(`    ${judge(codes).text}`);
  out.push('');

  // 营养
  const vs = (result.summary && result.summary.vsNrv) || {};
  if (Object.keys(vs).length) {
    out.push('  营养账本（三件整单）');
    for (const key of ['energyKcal', 'protein', 'fat', 'carb', 'sodium', 'calcium']) {
      const v = vs[key];
      if (!v) continue;
      out.push(
        `    ${pad(v.label, 12)}${pad(v.value + ' ' + v.unit, 14)}`
        + `${bar(v.dailyPercent)} ${v.dailyPercent}% NRV`
      );
    }
    out.push('');
  }

  // 钱
  const price = result.price;
  const comboHit = result.combo && result.combo.available;
  out.push('  计价');
  if (price) {
    out.push(`    单点合计 ¥${money(price.payable)}${price.discount > 0 ? `（已优惠 ¥${money(price.discount)}）` : ''}`);
  } else {
    out.push('    单点合计：计价失败，服务端没给价格');
  }

  if (comboHit) {
    const c = result.combo;
    const slots = (c.slots || []).map((s) => `${s.roundName}·${s.name}`).join(' + ');
    out.push(`    1+1「${c.name}」：${slots} → ¥${money(c.payable)}`);
    if (c.extraItems && c.extraItems.length) {
      const extra = c.extraItems.map((e) => e.name).join('、');
      out.push(`    ${extra}不进套餐，照单点算：本单实付 ¥${money(c.totalPayable)}，省 ¥${money(c.saving)}（${c.discountLabel}）`);
    } else {
      out.push(`    本单实付 ¥${money(c.payable)}，省 ¥${money(c.saving)}（${c.discountLabel}）`);
    }
  } else if (result.combo && result.combo.reason === 'no_combo') {
    out.push('    1+1：这家店当前时段没有随心配（按餐段上架，早餐时段通常没有）');
  } else if (result.combo) {
    out.push(`    1+1：${result.combo.note || '这三件拼不出套餐'}`);
  }
  out.push('');

  // 提示
  const notes = (result.notes || []).filter((n) => n && n.text);
  if (notes.length) {
    out.push('  提示');
    for (const n of notes) out.push(`    - ${n.text}`);
    out.push('');
  }

  if (result.priceError) {
    out.push(`  计价异常：${result.priceError}`);
    out.push('');
  }

  return out.join('\n');
}

function renderStores(list, ctx = {}) {
  const out = [];
  out.push('');
  out.push(`  门店搜索结果（${list.length} 家）`);
  out.push(line('-'));
  list.forEach((s, i) => {
    out.push(`  ${String(i + 1).padStart(2)}. ${s.name || s.storeName || '(名字为空)'}`);
    out.push(`      ${s.storeCode || s.code || ''}  ${s.businessStatus === false ? '[打烊中]' : ''}`);
    if (s.address) out.push(`      ${s.address}`);
  });
  out.push('');
  if (ctx.note) out.push(`  ${ctx.note}`);
  out.push('  选店：node scripts/mcshake.js use <编号或列表序号>');
  out.push('');
  return out.join('\n');
}

function renderPreview(pv) {
  const out = [];
  out.push('');
  out.push('  下单确认（还没建单）');
  out.push(line('-'));
  out.push(`  金额  ¥${money(pv.payable)}${pv.discount > 0 ? `（已优惠 ¥${money(pv.discount)}）` : ''}`);
  (pv.items || []).forEach((it, i) => out.push(`    ${i + 1}. ${it.name}`));
  // 预览接口的 combo 没有 available 字段，有 name 就代表拼成了
  if (pv.combo && pv.combo.name) {
    const c = pv.combo;
    const slots = (c.slots || []).map((s) => `${s.roundName}·${s.name}`).join(' + ');
    out.push(`  拼成「${c.name}」：${slots} → ¥${money(c.payable)}`);
    if (c.extraItems && c.extraItems.length) {
      out.push(`  不拼套餐的：${c.extraItems.map((e) => e.name).join('、')}（照单点算）`);
    }
  }
  const tw = (pv.takeWayList || []).map((t) => `${t.title}(${t.code})`).join(' / ');
  out.push(`  取餐方式  ${tw || '服务端没返回，暂时不能建单'}`);
  const firstCode = (pv.takeWayList && pv.takeWayList[0] && pv.takeWayList[0].code) || 'eat-in';
  out.push('');
  out.push(`  确认建单：node scripts/mcshake.js order create --take-way ${firstCode} --yes`);
  out.push('  注意：MCP 没有支付工具，建单后只能拿到一个 H5 收银台链接，付款要人来做。');
  out.push('');
  return out.join('\n');
}

function renderCreated(order) {
  const out = [];
  out.push('');
  out.push('  订单已创建（待支付）');
  out.push(line('-'));
  out.push(`  订单号    ${order.orderId}`);
  out.push(`  金额      ¥${money(order.payable)}${order.discount > 0 ? `（已优惠 ¥${money(order.discount)}）` : ''}`);
  out.push(`  状态      ${order.status ? order.status.text : '未知'}`);
  if (order.storeName) out.push(`  门店      ${order.storeName}`);
  if (order.expirePayTime) out.push(`  支付截止  ${order.expirePayTime}（15 分钟内）`);
  if (order.payH5Url) {
    out.push('');
    out.push('  付款链接（手机打开或用二维码工具扫）：');
    out.push(`  ${order.payH5Url}`);
  } else {
    out.push('');
    out.push('  接口没给付款链接，可到麦当劳 APP「我的订单」里继续支付。');
  }
  out.push('');
  out.push(`  查状态：node scripts/mcshake.js order status ${order.orderId}`);
  out.push(`  不要了：node scripts/mcshake.js order cancel ${order.orderId}`);
  out.push('');
  return out.join('\n');
}

function renderStatus(order) {
  const out = [];
  out.push('');
  out.push(`  订单 ${order.orderId}`);
  out.push(`  状态  ${order.status ? order.status.text : '未知'}${order.pickupCode ? '   取餐号 ' + order.pickupCode : ''}`);
  out.push(`  金额  ¥${money(order.payable)}`);
  if (order.expirePayTime) out.push(`  支付截止  ${order.expirePayTime}`);
  out.push('');
  return out.join('\n');
}

module.exports = { renderSpin, renderStores, renderPreview, renderCreated, renderStatus, judge, money };
