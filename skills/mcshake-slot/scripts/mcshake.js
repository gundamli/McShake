#!/usr/bin/env node
/**
 * 麦摇摇 McShake · 命令行玩法入口
 *
 * 设计原则：算账和玩法逻辑只在 server.js 里有一份，这里只做「摇 / 查 / 下单」的编排，
 * 所有结果都跟网页上看到的完全一致。
 *
 * 子命令：
 *   spin             摇一局：停位 + 营养 + 计价 + 1+1（默认玩法入口）
 *   order preview    只算不建，看金额与取餐方式
 *   order create     真建一笔待支付订单，返回付款链接
 *   order status     查订单状态
 *   order cancel     取消订单
 *   symbols          列出滚轮里的符号与单价
 *   stores / use     搜门店 / 记住门店
 *   serve            起一个常驻服务给浏览器玩（前台阻塞）
 *   status           看已记住的门店、上一次开奖、有没有服务在跑
 *   stop             清掉可能残留的服务进程
 */
const fs = require('fs');
const path = require('path');

const { resolveProjectRoot } = require('./lib/root');
const service = require('./lib/service');
const { request } = require('./lib/http');
const render = require('./lib/render');

// ------------------------------------------------------------------ 参数解析
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

/** 借服务跑一段活；需要连接时先给个提示，别让人对着空终端等 */
async function withServer(flags, work) {
  const root = resolveProjectRoot();
  const demo = flags.demo ? true : undefined;
  return service.withServer({ root, demo }, async (base, info) => {
    if (info.owned && !info.health.demo) {
      console.error('  正在连接 MCP 并加载门店菜单，第一次会慢一点…');
    }
    return work({ root, base, info });
  });
}
// ------------------------------------------------------------------ 门店
const fetchSymbols = (base) => request(base, '/api/slot/symbols', { timeout: 120000 });
const fetchStores = (base, { city, keyword }) =>
  request(base, '/api/stores', { method: 'POST', body: { city: city || '', keyword: keyword || '' } });

const selectStore = (base, store) =>
  request(base, '/api/store/select', {
    method: 'POST',
    timeout: 180000,
    body: {
      storeCode: store.storeCode || store.code,
      storeName: store.name || store.storeName,
      storeAddress: store.address,
      beCode: store.beCode,
      businessStatus: store.businessStatus,
      businessStartTime: store.businessStartTime,
      businessEndTime: store.businessEndTime,
    },
  });

function rememberStore(store, isDemo) {
  service.patchState({
    store: {
      storeCode: store.storeCode || store.code,
      name: store.name || store.storeName,
      address: store.address,
      // 演示快照里的门店在实时模式不一定存在，记住时要标清来源
      demo: Boolean(isDemo),
    },
  });
}

/**
 * 拿符号之前必须有门店。演示模式启动时就带了门店，实时模式要靠这里补：
 * 先试记住的那家（且数据源要对得上），再试收藏门店，都没有就把候选列出来让人选——
 * 门店选错的后果是下到别人店里，所以不能默默挑一家。
 */
async function ensureStore(base, flags, info) {
  await ensureSelected(base, flags, info);
  const res = await fetchSymbols(base);
  if (!res || !res.ok) fail(`符号加载失败：${(res && res.error) || '未知错误'}`);
  return res;
}

/**
 * 只把门店选定，不拉符号。
 * 下单预览/建单只需要门店上下文，没必要为此把整张菜单和可售性预检跑一遍——
 * 而 /api/health 里的 storeCode 就是现成的「有没有选过门店」。
 */
async function ensureSelected(base, flags, info) {
  const isDemo = Boolean(info && info.health && info.health.demo);
  if (info && info.health && info.health.storeCode) return true;

  const remembered = service.readState().store;
  if (remembered && remembered.storeCode && Boolean(remembered.demo) === isDemo) {
    const sel = await selectStore(base, remembered);
    if (sel && sel.ok) return true;
  }

  const storesRes = await fetchStores(base, { city: flags.city, keyword: flags.keyword });
  if (!storesRes || !storesRes.ok) {
    fail(`门店不可用：${(storesRes && storesRes.error) || '门店接口没有返回结果'}`
      + (storesRes && storesRes.note ? `\n${storesRes.note}` : ''), 2);
  }
  const list = storesRes.stores || [];
  if (!list.length) fail(`没搜到门店${flags.city ? '（城市 ' + flags.city + '）' : ''}。换个城市或关键词再试。`, 2);

  const explicit = Boolean(flags.city || flags.keyword);
  if (list.length > 1 && !explicit) {
    console.error(render.renderStores(list, { note: storesRes.note }));
    fail('有多家门店，先选一家：node scripts/mcshake.js use <序号>', 2);
  }

  const picked = list[0];
  console.error(`  门店：${picked.name}（${picked.storeCode || picked.code}）`);
  const sel = await selectStore(base, picked);
  if (!sel || !sel.ok) fail(`选门店失败：${(sel && sel.error) || '未知错误'}`);
  rememberStore(picked, isDemo);
  return true;
}

// ------------------------------------------------------------------ 子命令
async function cmdServe(flags) {
  const root = resolveProjectRoot();
  const svc = await service.serve({
    root,
    demo: Boolean(flags.demo),
    port: flags.port ? Number(flags.port) : undefined,
  });
  const h = svc.health;
  console.log('');
  console.log(svc.reused ? '  已有一个服务在跑，直接复用' : '  服务已启动（前台运行，关掉这个进程服务就没了）');
  console.log(`  地址    ${service.base(svc.port)}`);
  console.log(`  数据源  ${h.demo ? '演示快照' + (h.demoSnapshotAt ? '（抓于 ' + h.demoSnapshotAt + '）' : '') : '实时 MCP（' + (h.toolCount || 0) + ' 个工具）'}`);
  console.log(`  门店    ${h.storeName || '未选择'}${h.storeCode ? '（' + h.storeCode + '）' : ''}`);
  console.log(`  菜单    ${h.menuSize || 0} 件`);
  console.log('');
  if (!flags.foreground && svc.child) {
    // 前台 shell 一退出进程就没了，所以这里自己挂住
    await new Promise(() => {});
  }
  return 0;
}

async function cmdStatus(flags) {
  const state = service.readState();
  const running = await service.findRunning(undefined);

  console.log('');
  console.log(`  项目    ${resolveProjectRoot()}`);
  console.log(`  数据源  ${process.env.MCD_MCP_TOKEN ? 'MCD_MCP_TOKEN 已设置（走实时）' : '没有 Token（走演示快照）'}`);
  console.log(`  门店    ${state.store ? state.store.name + '（' + state.store.storeCode + '）' : '还没记住，下一局会自动选收藏门店'}`);
  if (state.lastSpin) {
    console.log(`  上一局  ${state.lastSpin.codes.join(' / ')} · ${state.lastSpin.names.join(' / ')}`);
  }
  console.log(`  服务    ${running ? '有，端口 ' + running.port + '（' + (running.health.demo ? '演示' : '实时') + '）' : '没有常驻服务（每条命令自带临时服务，不影响使用）'}`);
  console.log('');
  return 0;
}

async function cmdStop() {
  const r = service.killStale();
  console.log(r.killed ? `  已结束残留进程 ${r.pid}` : '  没有需要清理的进程');
  return 0;
}

async function cmdStores(flags) {
  return withServer(flags, async ({ base }) => {
    const res = await fetchStores(base, { city: flags.city, keyword: flags.keyword });
    if (!res || !res.ok) fail(`门店搜索失败：${(res && res.error) || '未知错误'}`);
    const list = res.stores || [];
    service.patchState({ lastSearch: { city: flags.city || '', keyword: flags.keyword || '' } });
    if (flags.json) { console.log(JSON.stringify(list, null, 1)); return 0; }
    console.log(render.renderStores(list, { note: res.note }));
    return 0;
  });
}

async function cmdUse(flags, positional) {
  const target = positional[0];
  if (!target) fail('用法：node scripts/mcshake.js use <序号或 storeCode>');

  return withServer(flags, async ({ base, info }) => {
    const last = service.readState().lastSearch || {};
    const city = flags.city || last.city;
    const keyword = flags.keyword || last.keyword;

    const res = await fetchStores(base, { city, keyword });
    const list = (res && res.stores) || [];
    if (!list.length) fail('没有可用的门店列表，先用 stores 搜一次');

    const idx = Number(target);
    let picked = null;
    if (Number.isInteger(idx) && idx >= 1 && idx <= list.length) picked = list[idx - 1];
    else picked = list.find((s) => String(s.storeCode || s.code) === String(target));
    if (!picked) fail(`没有找到门店 ${target}。序号范围 1-${list.length}，或直接给 storeCode。`);

    const sel = await selectStore(base, picked);
    if (!sel || !sel.ok) fail(`选门店失败：${(sel && sel.error) || '未知错误'}`);
    rememberStore(picked, info.health.demo);

    console.log('');
    console.log(`  已记住门店  ${picked.name}（${picked.storeCode || picked.code}）`);
    if (picked.address) console.log(`  地址        ${picked.address}`);
    console.log(`  在售餐品    ${sel.menuSize != null ? sel.menuSize : '已加载'} 件`);
    console.log('');
    return 0;
  });
}

async function cmdSymbols(flags) {
  return withServer(flags, async ({ base, info }) => {
    const res = await ensureStore(base, flags, info);
    if (!res || !res.ok) fail(`符号加载失败：${(res && res.error) || '未知错误'}`);
    if (res.storeInfo && res.storeInfo.name) {
      rememberStore({ storeCode: res.storeInfo.code, name: res.storeInfo.name, address: res.storeInfo.address }, res.demo);
    }
    if (flags.json) { console.log(JSON.stringify(res.symbols, null, 1)); return 0; }
    console.log('');
    console.log(`  滚轮符号（${res.symbols.length} 个）${res.demo ? ' · 演示快照' : ''}`);
    console.log('  ' + '-'.repeat(46));
    for (const s of res.symbols) {
      const price = s.unitPrice != null ? `¥${Number(s.unitPrice).toFixed(2)}` : '未标价';
      const tags = [s.rare ? '稀有' : '', s.isCombo ? '套餐' : '', s.available === false ? '不可售' : ''].filter(Boolean).join(' ');
      console.log(`  ${String(s.code).padEnd(8)}${price.padEnd(10)}${s.name}${tags ? '  [' + tags + ']' : ''}`);
    }
    console.log('');
    return 0;
  });
}

/** mulberry32：想让某一局可复现（写文档、截图）时用，正常玩不传 --seed */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function cmdSpin(flags) {
  return withServer(flags, async ({ root, base, info }) => {
    const symRes = await ensureStore(base, flags, info);
    if (!symRes || !symRes.ok) fail(`符号加载失败：${(symRes && symRes.error) || '未知错误'}`);

    // 开奖必须用库里同一份概率表，不能在这里另写一套，
    // 否则对话里摇的和网页上摇的概率不一样。
    const slot = require(path.join(root, 'src', 'slot.js'));
    const rand = flags.seed ? mulberry32(Number(flags.seed)) : Math.random;
    const picked = slot.spin(symRes.symbols, rand);
    const codes = picked.map((s) => String(s.code || s.id));

    const res = await request(base, '/api/slot/result', {
      method: 'POST',
      body: { codes },
      timeout: 180000,
    });
    if (!res || !res.ok) fail(`开奖失败：${(res && res.error) || '未知错误'}`);

    const store = res.storeInfo || {};
    service.patchState({
      lastSpin: {
        codes,
        names: (res.items || []).map((i) => i.name),
        storeName: store.name || '',
        demo: Boolean(symRes.demo),
        at: new Date().toISOString(),
      },
    });
    // 门店要带数据源标记，否则演示快照里的门店会被拿到实时模式里乱用
    if (store.name) {
      rememberStore({ storeCode: store.code, name: store.name, address: store.address }, symRes.demo);
    }

    if (flags.json) { console.log(JSON.stringify({ codes, result: res }, null, 1)); return 0; }
    console.log(render.renderSpin(res, {
      demo: Boolean(symRes.demo),
      snapshotAt: symRes.demoSnapshotAt,
      storeName: store.name || '',
    }));
    return 0;
  });
}

async function cmdOrder(flags, positional) {
  const action = positional[0];
  if (!action) fail('用法：order preview | create | status <id> | cancel <id>');

  const codesFromArgs = () => (flags.codes ? String(flags.codes).split(',').map((s) => s.trim()) : null);
  const codesFromState = () => {
    const last = service.readState().lastSpin;
    return last && Array.isArray(last.codes) ? last.codes : null;
  };

  return withServer(flags, async ({ base, info }) => {
    if (action === 'preview' || action === 'create') {
      const codes = codesFromArgs() || codesFromState();
      if (!codes || codes.length !== 3) fail('没有可结算的组合。先 spin 一局，或用 --codes a,b,c 指定。', 2);

      if (action === 'preview') {
        await ensureSelected(base, flags, info);
        const res = await request(base, '/api/order/preview', { method: 'POST', body: { codes }, timeout: 180000 });
        if (!res || !res.ok) fail(`金额复核失败：${(res && res.error) || '未知错误'}`);
        if (flags.json) { console.log(JSON.stringify(res, null, 1)); return 0; }
        console.log(render.renderPreview(res));
        return 0;
      }

      // 建单会在用户账号里留一笔真实待支付订单，没有 --yes 一律不建
      if (!flags.yes) {
        console.error('  建单会真的在你的麦当劳账号里生成一笔待支付订单。');
        console.error('  未付款不会扣钱，但会计入账号当日下单数，且需要人工关单。');
        console.error(`  确认无误请加 --yes 重跑：node scripts/mcshake.js order create --take-way ${flags['take-way'] || 'eat-in'} --yes`);
        return 2;
      }
      await ensureSelected(base, flags, info);
      const res = await request(base, '/api/order/create', {
        method: 'POST',
        timeout: 180000,
        body: { codes, takeWayCode: flags['take-way'] || undefined },
      });
      if (!res || !res.ok) fail(`建单失败：${(res && res.error) || '未知错误'}`);
      if (flags.json) { console.log(JSON.stringify(res, null, 1)); return 0; }
      console.log(render.renderCreated(res.order));
      return 0;
    }

    if (action === 'status') {
      const id = positional[1] || flags.id;
      if (!id) fail('用法：node scripts/mcshake.js order status <orderId>');
      const res = await request(base, `/api/order/status?orderId=${encodeURIComponent(id)}`, { timeout: 60000 });
      if (!res || !res.ok) fail(`查询失败：${(res && res.error) || '未知错误'}`);
      if (flags.json) { console.log(JSON.stringify(res, null, 1)); return 0; }
      console.log(render.renderStatus(res.order));
      return 0;
    }

    if (action === 'cancel') {
      const id = positional[1] || flags.id;
      if (!id) fail('用法：node scripts/mcshake.js order cancel <orderId>');
      const res = await request(base, '/api/order/cancel', {
        method: 'POST',
        timeout: 60000,
        body: { orderId: id, cancelReasonCode: flags.reason || '1' },
      });
      if (!res || !res.ok) fail(`取消失败：${(res && res.error) || '未知错误'}`);
      console.log(`  已取消订单 ${id}`);
      return 0;
    }

    fail('用法：order preview | create | status <id> | cancel <id>');
  });
}

// ------------------------------------------------------------------ 入口
async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional.shift();

  try {
    switch (cmd) {
      case 'serve': return await cmdServe(flags);
      case 'status': return await cmdStatus(flags);
      case 'stop': return await cmdStop();
      case 'stores': return await cmdStores(flags);
      case 'use': return await cmdUse(flags, positional);
      case 'symbols': return await cmdSymbols(flags);
      case 'spin': return await cmdSpin(flags);
      case 'order': return await cmdOrder(flags, positional);
      case undefined:
      case 'help':
        console.log(fs.readFileSync(path.join(__dirname, '..', 'references', 'cli-usage.txt'), 'utf8'));
        return 0;
      default:
        fail(`未知命令 ${cmd}。可用：spin / order / symbols / stores / use / serve / status / stop`);
    }
  } catch (err) {
    if (err && err.code === 'NO_PROJECT') fail(err.message, 3);
    fail(`执行失败：${err && err.message ? err.message : err}`);
  }
}

main().then((code) => process.exit(code || 0));
