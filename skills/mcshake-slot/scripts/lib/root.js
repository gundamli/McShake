/**
 * 定位 McShake 项目根目录。
 *
 * 这个技能有两种存在方式：
 *   1) 跟着仓库走：<repo>/skills/mcshake-slot/，往上三级就是仓库根；
 *   2) 装成用户级技能：~/.workbuddy/skills/mcshake-slot/，此时往上找不到仓库，
 *      需要靠 config.json 里记下的绝对路径（安装时写入）或环境变量。
 *
 * 找到之后要能真的跑起来才算数，所以判定条件是「server.js + src/mcp-client.js +
 * public/slot.html 三个都在」，只认 package.json 会误判到别的 Node 项目。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKERS = ['server.js', path.join('src', 'mcp-client.js'), path.join('public', 'slot.html')];

function looksLikeProject(dir) {
  if (!dir) return false;
  try {
    return MARKERS.every((m) => fs.existsSync(path.join(dir, m)));
  } catch (_) {
    return false;
  }
}

function readConfigHome() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf8'));
    return cfg && typeof cfg.home === 'string' ? cfg.home : null;
  } catch (_) {
    return null;
  }
}

/** 从某个目录一路往上找，命中即返回 */
function walkUp(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (looksLikeProject(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 兜底：扫 ~/WorkBuddy/<日期目录>/McShake。
 * 只是为了让「装到用户级技能目录、又没写 config.json」的情况也能用，
 * 找不到就老实报错，不要瞎猜一个路径。
 */
function scanWorkBuddy() {
  const base = path.join(os.homedir(), 'WorkBuddy');
  const hits = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.join(base, e.name, 'McShake');
    if (looksLikeProject(candidate)) hits.push(candidate);
  }
  if (!hits.length) return null;
  // 有多个时取最近修改过的那个
  hits.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return hits[0];
}

function resolveProjectRoot() {
  const tried = [];

  if (process.env.MCSHAKE_HOME) {
    tried.push(`MCSHAKE_HOME=${process.env.MCSHAKE_HOME}`);
    if (looksLikeProject(process.env.MCSHAKE_HOME)) return process.env.MCSHAKE_HOME;
  }

  const cfgHome = readConfigHome();
  if (cfgHome) {
    tried.push(`config.json home=${cfgHome}`);
    if (looksLikeProject(cfgHome)) return cfgHome;
  }

  const upFromSkill = walkUp(path.resolve(__dirname, '..', '..', '..', '..'));
  if (upFromSkill) return upFromSkill;
  tried.push('从技能目录向上查找');

  const upFromCwd = walkUp(process.cwd());
  if (upFromCwd) return upFromCwd;
  tried.push(`从当前目录向上查找（${process.cwd()}）`);

  const scanned = scanWorkBuddy();
  if (scanned) return scanned;
  tried.push(`扫描 ${path.join(os.homedir(), 'WorkBuddy')}/*/McShake`);

  const err = new Error(
    '找不到 McShake 项目目录。试过：\n  - ' + tried.join('\n  - ') +
    '\n请设置环境变量 MCSHAKE_HOME=<McShake 仓库绝对路径>，或在该技能目录写 config.json：{"home":"<路径>"}'
  );
  err.code = 'NO_PROJECT';
  throw err;
}

module.exports = { resolveProjectRoot, looksLikeProject };
