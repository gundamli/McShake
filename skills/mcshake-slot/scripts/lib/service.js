/**
 * 本地服务生命周期。
 *
 * 为什么技能不自己直连 MCP，而是把本地服务拉起来打它的 HTTP 接口：
 *   玩法逻辑（选符号、计价、1+1 拼单、下单）在 server.js 里只有一份，
 *   重写一遍必然和网页版跑偏。套一层 HTTP，对话里和网页上看到的是同一套结果。
 *
 * 为什么默认「一条命令一个临时服务」：
 *   常驻后台进程在多数执行环境里会被回收（进程树跟着 shell 一起没了），
 *   留一个状态文件指向已经死掉的端口只会制造假故障。所以默认自带自灭：
 *   起服务 → 办完事 → 关掉。只有 serve 才起常驻服务，供浏览器打开玩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { probe } = require('./http');

const DEFAULT_PORT = 8787;
const PORT_SPAN = 6;
const TMP_DIR = path.join(os.tmpdir(), 'mcshake-skill');
const STATE_FILE = path.join(TMP_DIR, 'state.json');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function patchState(patch) {
  const next = Object.assign({}, readState(), patch);
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 1));
  } catch (_) { /* 状态写不了不影响主流程 */ }
  return next;
}

/** 端口上跑的是不是 McShake（而不是别的什么服务） */
function isMcShake(health) {
  if (!health || health.ok !== true) return false;
  return typeof health.menuSize === 'number' || typeof health.librarySize === 'number' || 'demo' in health;
}

function base(port) {
  return `http://127.0.0.1:${port}`;
}

/** 找一个已经在跑的 McShake；wantDemo 显式要求数据源一致，避免演示/实时串味 */
async function findRunning(wantDemo) {
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SPAN; p++) {
    const health = await probe(base(p), 900);
    if (!isMcShake(health)) continue;
    if (wantDemo === true && !health.demo) continue;
    if (wantDemo === false && health.demo) continue;
    return { port: p, health };
  }
  return null;
}

async function start({ root, port, demo }) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const logFile = path.join(TMP_DIR, `server-${port}.log`);
  const out = fs.openSync(logFile, 'a');

  const env = Object.assign({}, process.env, { PORT: String(port) });
  // 有 Token 走实时；--demo 或没有 Token 时走快照
  if (demo) {
    env.MCSHAKE_DEMO = '1';
    delete env.MCD_MCP_TOKEN;
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });

  // 端口一通就返回是不够的：server.js 的 listen 回调里才去连 MCP / 载入快照，
  // 这时候打 /api/slot/symbols 会拿到「尚未连接 MCP 服务」。
  // 所以还要等到「已连上」或「已进演示模式」才算真的可用。
  const deadline = Date.now() + 40000;
  let last = null;
  while (Date.now() < deadline) {
    if (child.exitCode != null) break;
    const health = await probe(base(port), 800);
    if (isMcShake(health)) {
      last = health;
      if (health.demo || health.connected) return { port, health, child, logFile };
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (last) return { port, health: last, child, logFile };
  try { child.kill(); } catch (_) { /* 忽略 */ }
  let tail = '';
  try { tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-15).join('\n'); } catch (_) { /* 忽略 */ }
  const err = new Error(`服务在端口 ${port} 启动失败。启动日志：\n${tail || '(空)'}`);
  err.code = 'START_FAILED';
  throw err;
}

/**
 * 借一个服务用：优先复用已经在跑的（可能正是用户开着的网页），
 * 否则自己起一个，用完关掉。
 */
async function withServer(options, fn) {
  const { root, demo = undefined } = options;
  const running = await findRunning(demo);
  if (running) {
    return fn(base(running.port), { port: running.port, health: running.health, owned: false });
  }

  let lastErr = null;
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + PORT_SPAN; p++) {
    const busy = await probe(base(p), 700);
    if (busy) continue;                       // 被别的程序占着，换一个
    let svc = null;
    try {
      svc = await start({ root, port: p, demo: Boolean(demo) });
      return await fn(base(p), { port: p, health: svc.health, owned: true });
    } catch (err) {
      lastErr = err;
    } finally {
      if (svc && svc.child) {
        try { svc.child.kill(); } catch (_) { /* 忽略 */ }
      }
    }
  }
  throw lastErr || new Error('没有可用端口，服务没能启动');
}

/** serve：起一个常驻服务给浏览器用（前台阻塞，交给 run_in_background 跑） */
async function serve({ root, demo, port }) {
  const running = await findRunning(demo);
  if (running) return { reused: true, port: running.port, health: running.health };

  const target = port || DEFAULT_PORT;
  return start({ root, port: target, demo: Boolean(demo) });
}

/** 清掉上一次可能残留的服务进程（正常不会用到，留给异常退出兜底） */
function killStale() {
  const st = readState();
  if (!st.pid) return { killed: false };
  try {
    process.kill(st.pid, 'SIGTERM');
    patchState({ pid: null });
    return { killed: true, pid: st.pid };
  } catch (_) {
    patchState({ pid: null });
    return { killed: false };
  }
}

module.exports = {
  withServer, serve, findRunning, killStale, isMcShake, base,
  readState, patchState, DEFAULT_PORT, TMP_DIR, STATE_FILE,
};
