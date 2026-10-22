'use strict';

/**
 * 一键下单：把「摇出的餐品 + 1+1 判断结果」翻译成 create-order 能吃的参数，
 * 并把官方的订单回包收敛成前端要的几个字段。
 *
 * 实测契约（2026-10-22，真实 Token / 门店 3330433）：
 *   - calculate-price 返回的 `takeWayList` 是**下单必传**的 takeWayCode 来源：
 *     `[{ code: 'eat-in', title: '堂食' }, { code: 'take-in-store', title: '外带' }]`
 *     到店场景缺这个参数会直接被拒（600010 检查必填参数）。
 *   - calculate-price 的金额单位是**分**（`price: 2690`），
 *     create-order 回包却是**元的字符串**（`realTotalAmount: "26.9"`），两边不能混用。
 *   - 促销由服务端自动匹配，不需要传 couponId；支付窗口固定 15 分钟。
 *   - 没有支付类工具：`payH5Url` 只能交给人扫码，付款结果靠轮询 query-order。
 */

/** takeWayList → 标准化选项（下拉框直接用这个） */
function normalizeTakeWay(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || t.code == null) continue;
    const code = String(t.code);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({
      code,
      title: String(t.title || t.name || code),
      subtitle: String(t.subtitle || ''),
    });
  }
  return out;
}

/**
 * 挑出实际要用的取餐方式。
 * 用户的选择必须在白名单里，否则退回第一个——不能把前端传来的任意字符串
 * 直接塞给下单接口。
 */
function pickTakeWay(list, wanted) {
  if (!Array.isArray(list) || !list.length) return null;
  if (wanted) {
    const hit = list.find((t) => t.code === String(wanted));
    if (hit) return hit;
  }
  return list[0];
}

/**
 * 构造 create-order 的 items。
 *
 * 能拼 1+1 时要拆成「套餐项（带 roundList）+ 剩余单品」：
 * 只传套餐码会丢第三件，只传单品会丢套餐价。
 *
 * @param {Array<{code:string}>} items 摇出的餐品
 * @param {Object|null} comboDeal evaluateCombo 的返回值
 */
function buildOrderItems(items, comboDeal) {
  const plain = (Array.isArray(items) ? items : [])
    .filter((i) => i && i.code)
    .map((i) => ({ productCode: String(i.code), quantity: 1 }));

  if (!comboDeal || !comboDeal.available) return plain;
  if (!Array.isArray(comboDeal.roundList) || !comboDeal.roundList.length) return plain;

  const out = [{
    productCode: String(comboDeal.code),
    quantity: 1,
    roundList: comboDeal.roundList.map((r) => ({
      round: String(r.round),
      comboItemList: (r.comboItemList || []).map((c) => ({
        code: String(c.code),
        quantity: Number(c.quantity) || 1,
      })),
    })),
  }];

  for (const e of comboDeal.extraItems || []) {
    if (!e || !e.code) continue;
    out.push({ productCode: String(e.code), quantity: 1 });
  }
  return out;
}

/** 金额：create-order 给的是元的字符串，统一转成数字元 */
function toYuan(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * "2026-10-22 08:02:47" → 毫秒时间戳。
 * 官方给的是门店本地时间（UTC+8），不带时区，直接 Date.parse 会被当成本机时区。
 */
function parseExpireAt(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}

/**
 * 订单状态：官方给中文 `orderStatus` 与数字 `status`（10 待支付 / 60 已取消）。
 * 付款方式只有人扫码，所以「已支付」只能从状态文本判断，接口没有单独的 paid 字段。
 */
function describeStatus(order) {
  const text = String((order && order.orderStatus) || '');
  const code = String((order && order.status) || '');
  const cancelled = code === '60' || /取消/.test(text);
  const paid = !cancelled && /已支付|已付款|已完成|已完成订单|制作中|待取餐|待取/.test(text);
  return {
    code: code || null,
    text: text || '未知',
    paid,
    cancelled,
    waiting: !paid && !cancelled,
  };
}

/**
 * 收敛 create-order / query-order 的回包。
 * 两个接口的 data 结构基本一致，所以共用。
 */
function normalizeOrder(data) {
  if (!data || typeof data !== 'object') return null;
  const detail = data.orderDetail || data;
  const status = describeStatus(detail);

  return {
    orderId: data.orderId || detail.orderId || null,
    payH5Url: data.payH5Url || null,
    payId: data.payId || detail.payId || null,
    status,
    storeName: detail.storeName || '',
    storeAddress: detail.storeAddress || '',
    takeWay: detail.takeWay || '',
    pickupCode: detail.pickupCode || '',
    totalAmount: toYuan(detail.totalAmount),
    payable: toYuan(detail.realTotalAmount),
    discount: toYuan(detail.totalDiscountAmount),
    couponList: Array.isArray(detail.couponList) ? detail.couponList : [],
    products: (Array.isArray(detail.orderProductList) ? detail.orderProductList : []).map((p) => ({
      name: p.productName || '',
      quantity: Number(p.quantity) || 1,
      price: toYuan(p.price),
      image: p.productImage || null,
      comboItems: (p.comboItemList || []).map((c) => ({
        name: c.itemName || '',
        quantity: Number(c.itemQuantity) || 1,
      })),
    })),
    createTime: detail.createTime || null,
    expirePayTime: detail.expirePayTime || null,
    expireAt: parseExpireAt(detail.expirePayTime),
    remark: detail.remark || '',
  };
}

module.exports = {
  normalizeTakeWay,
  pickTakeWay,
  buildOrderItems,
  toYuan,
  parseExpireAt,
  describeStatus,
  normalizeOrder,
};
