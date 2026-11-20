#!/usr/bin/env node
/**
 * 教务抢课助手（同学版）
 * ------------------------------------------------------------------
 * 用法：双击 开始.bat  或  node xkg.mjs
 *
 * 安全默认值：
 *   - 默认「只提醒」模式：发现余量只弹通知，不提交任何东西
 *   - 「自动抢」模式必须启动时手动输入 YES 才生效
 *   - 轮询间隔最小 3 秒（写死下限），不做高并发
 *   - 密码默认不落盘（每次启动输入），可选记住
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initOcr, recognizeJpeg } from './ocr.mjs';

// 自身所在目录：编译成 exe 后用 exe 路径，直接用 node 跑时用脚本路径
const DIR = (() => {
  try {
    if (process.versions && process.versions.bun) return path.dirname(process.execPath);
    return path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : process.cwd());
  } catch { return process.cwd(); }
})();
const CFG = path.join(DIR, 'config.json');
const LOGF = path.join(DIR, 'xk.log');
const CAPF = path.join(DIR, 'captcha.jpg');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_INTERVAL = 3;

const C = process.env.NO_COLOR ? null : {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m',
  yel: '\x1b[33m', blu: '\x1b[36m', mag: '\x1b[35m',
};
const c = (k, s) => (C ? C[k] + s + C.r : s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(line) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  try { fs.appendFileSync(LOGF, '[' + ts + '] ' + line + '\n'); } catch {}
}

// ---------------- 配置 ----------------
const DEFAULT_CFG = {
  user: '',
  pass: '',
  rememberPass: false,
  candidates: [],
  types: ['3'],         // 选课分类：3 校任选 / 4 系任选 / 5 自由选择 / 14 重修（可多个）
  group: '',            // 只选某个类别（如 人文与艺术类）
  teacher: '',          // 只选某位老师（如 紫金慕课）
  type: '3',
  interval: 3,
  mode: 'watch',
  hosts: ['192.168.16.207', '192.168.16.208', '192.168.16.209'],
  autoHost: true,
  ocrUrl: '',
};

function loadCfg() {
  try { return { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; }
  catch { return null; }
}
function saveCfg(cfg) {
  const out = { ...cfg };
  if (!cfg.rememberPass) out.pass = '';
  fs.writeFileSync(CFG, JSON.stringify(out, null, 2));
}

// ---- 输入层：单一缓冲读行（同时支持交互终端和管道输入）----
let feedBuf = '';
let pending = null;                 // { resolve, hidden }
function pumpLines() {
  while (pending) {
    const i = feedBuf.search(/[\r\n]/);
    if (i < 0) break;
    const line = feedBuf.slice(0, i);
    let rest = feedBuf.slice(i + 1);
    if (feedBuf[i] === '\r' && rest.startsWith('\n')) rest = rest.slice(1);   // ★ Windows 是 CRLF，必须连 \n 一起吃掉
    feedBuf = rest;
    const p = pending; pending = null;
    p.resolve(line);
  }
}
process.stdin.on('data', chunk => {
  const s = chunk.toString('utf8');
  if (pending && !pending.quiet) {          // 回显（密码用 *）
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') continue;
      if (ch === '\u007f' || ch === '\b') process.stdout.write('\b \b');
      else process.stdout.write(pending.hidden ? '*' : ch);
    }
  }
  feedBuf += s;
  pumpLines();
});
process.stdin.on('end', () => { if (pending) { const p = pending; pending = null; p.resolve(''); } });
process.stdin.on('error', () => {});
try { process.stdin.resume(); } catch {}

function readLine(prompt, hidden = false) {
  return new Promise(resolve => {
    if (prompt) process.stdout.write(prompt);
    pending = { resolve: v => { process.stdout.write('\n'); resolve(v); }, hidden };
    pumpLines();
  });
}
async function ask(q, def = '') {
  const a = String(await readLine(q + (def ? '（默认 ' + def + '）' : '') + ': ') || '').trim();
  return a || String(def);
}
async function askSecret(q) { return String(await readLine(q, true)).trim(); }

const GROUPS = ['经济与社会类', '自然与科学类', '人文与艺术类', '创新与技能类'];
/** 询问「老师 + 类别」筛选（都可留空 = 不限） */
async function askFilters(cfg) {
  console.log(c('dim', '  （老师、类别都可以直接回车 = 不限）'));
  cfg.teacher = (await ask('  老师关键字（如 紫金慕课）', '')).trim();
  console.log('  类别：' + GROUPS.map((g, i) => ' ' + (i + 1) + ' ' + g).join('  ') + '  （回车 = 不限）');
  const gi = (await ask('  类别序号', '')).trim();
  cfg.group = /^[1-4]$/.test(gi) ? GROUPS[Number(gi) - 1] : '';
  console.log(c('grn', '  → 已选：' + (cfg.teacher || '任意老师') + ' · ' + (cfg.group || '任意类别')));
}

async function wizard() {
  console.log(c('blu', '\n=== 首次使用，先配置一下 ==='));
  const cfg = { ...DEFAULT_CFG };
  cfg.user = await ask('学号');
  console.log(c('dim', '提示：密码建议每次启动手输（不写盘）。也可现在填好并选择记住。'));
  const p = await askSecret('教务密码（直接回车 = 每次启动再输）: ');
  if (p) {
    cfg.pass = p;
    cfg.rememberPass = (await ask('要在这台电脑上记住密码吗？(y/N)', 'n')).toLowerCase().startsWith('y');
  } else {
    console.log(c('dim', '  好的，密码不保存 —— 每次启动时会再问你一次。'));
  }
  console.log(c('blu', '\n【怎么选课】'));
  console.log('  ' + c('grn', '1') + '  指定具体课程（课程号或课名，最多 5 个，按优先级）');
  console.log('  ' + c('grn', '2') + '  按「类别 + 老师」自动选任意一门（例：紫金慕课 · 人文与艺术类）');
  const how = (await ask('请输入 1 或 2', '1')).trim() || '1';
  if (how === '2') {
    cfg.candidates = [];
    await askFilters(cfg);
  } else {
    console.log(c('dim', '\n  填课程号（如 99001731）或课程名（如 名画中的瘟疫史），最多 5 个。'));
    console.log(c('dim', '  一个都不填 = 自动改成按「类别 + 老师」选（就等于上面选 2）'));
    const cands = [];
    for (let i = 1; i <= 5; i++) {
      const a = await ask('  候选 ' + i + '（回车结束）');
      if (!a) break;
      cands.push(a);
    }
    cfg.candidates = cands;
    if (!cands.length) {
      console.log(c('yel', '\n  没填课程 → 那就按「类别 + 老师」选：'));
      await askFilters(cfg);
    }
  }
  cfg.interval = Math.max(MIN_INTERVAL, Number(await ask('轮询间隔秒数', '3')) || 3);
  const m = (await ask('模式：1=只提醒（推荐） 2=自动抢', '1')).trim();
  cfg.mode = m === '2' ? 'auto' : 'watch';
  saveCfg(cfg);
  console.log(c('grn', '\n✅ 配置已保存到 config.json\n'));
  return cfg;
}

// ---------------- 通知 ----------------
function notify(title, msg) {
  process.stdout.write('\x07');
  const esc = s => String(s).replace(/'/g, "''");
  const ps = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
    '$n=New-Object System.Windows.Forms.NotifyIcon; ' +
    '$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; ' +
    "$n.ShowBalloonTip(20000,'" + esc(title) + "','" + esc(msg) + "',[System.Windows.Forms.ToolTipIcon]::Info); " +
    'Start-Sleep -Seconds 20; $n.Dispose()';
  try {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
  const beep = "Add-Type -AssemblyName System.Windows.Forms; [console]::beep(880,200); [console]::beep(1175,200); [console]::beep(1397,300)";
  try { spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', beep], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

// ---------------- 网络层 ----------------
let BASE = 'http://192.168.16.207/';
let jar = new Map();
const ck = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const store = r => {
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const cc of list) { const f = cc.split(';')[0]; const i = f.indexOf('='); if (i > 0) jar.set(f.slice(0, i), f.slice(i + 1)); }
};
const dec = ab => { try { return new TextDecoder('utf-8', { fatal: true }).decode(ab); } catch { return new TextDecoder('gbk').decode(ab); } };
async function req(p, o = {}) {
  const url = /^https?:/.test(p) ? p : BASE + p.replace(/^\/+/, '');
  const method = (o.method || 'GET').toUpperCase();
  const h = { 'User-Agent': UA, Referer: BASE, ...(o.headers || {}) };
  if (method !== 'GET') h.Origin = BASE.replace(/\/$/, '');
  if (jar.size) h.Cookie = ck();
  // 高峰期网站很慢：GET 给 12s×3 次；POST 给 20s×1（重复提交有风险）
  const tries = o.tries || (method === 'GET' ? 3 : 1);
  const timeoutMs = o.timeoutMs || (method === 'GET' ? 12000 : 20000);
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { method, headers: h, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
        ...(o.body !== undefined ? { body: o.body } : {}) });
      store(r);
      return r;
    } catch (e) {
      log('请求失败 ' + i + '/' + tries + ' ' + url + ' ' + (e.name || '') + ' ' + (e.message || ''));
      if (i === tries) throw e;
      console.log(c('yel', '  网络慢/抖动，重试 ' + i + '/' + (tries - 1) + '…'));
      await sleep(600 * i);
      if (jar.size) h.Cookie = ck();
    }
  }
}

async function speedTest(hosts) {
  console.log(c('blu', '=== 测速（每个节点测一次，慢或不通也继续）==='));
  const out = [];
  for (const h of hosts) {
    const base = /^https?:/.test(h) ? h.replace(/\/+$/, '') + '/' : 'http://' + h + '/';
    process.stdout.write('  ' + h.padEnd(17));
    let ok = false, err = '', cost = Infinity;
    const t0 = performance.now();
    try {
      const r = await fetch(base + 'loginAction.do', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const ab = await r.arrayBuffer();
      if (!r.ok) err = 'HTTP ' + r.status;
      else if (ab.byteLength < 500) err = '内容异常';
      else { ok = true; cost = performance.now() - t0; }
    } catch (e) { err = e.name === 'TimeoutError' ? '超时（可能只是慢）' : '连不上'; }
    console.log(ok ? c('grn', '✅ ' + Math.round(cost) + 'ms') : c('red', '❌ ' + err));
    out.push({ base, host: h, ok, best: cost, err });
  }
  out.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.best - b.best));
  let win = out.find(r => r.ok);
  if (!win) {
    win = out[0];
    console.log(c('yel', '⚠️ 所有节点都没测通（抢课时网络慢属正常），仍选 ' + win.host + ' 硬上，失败会自动重试'));
  } else {
    console.log(c('grn', '✅ 采用 ' + BASE));
  }
  BASE = win.base;
  log('选节点 ' + BASE + ' (' + (win.ok ? Math.round(win.best) + 'ms' : '未测通，兜底') + ')');
  return true;          // ★ 永不返回失败
}

// ---------------- 登录 ----------------
let ocrReady = false;
async function initLocalOcr() {
  const md = path.join(DIR, 'model');
  const mp = path.join(md, 'common_old.onnx'), cp = path.join(md, 'charset.json');
  if (!fs.existsSync(mp) || !fs.existsSync(cp)) return false;
  try {
    ocrReady = await initOcr(mp, cp, path.join(md, 'ort'));
    return ocrReady;
  } catch (e) { log('本地 OCR 初始化失败: ' + (e && e.message)); return false; }
}

async function recognize(buf, cfg) {
  // 1) 本地模型（默认首选）
  if (ocrReady) {
    try {
      const t = await recognizeJpeg(buf);
      if (t && /^[0-9A-Za-z]{3,6}$/.test(t)) return t;
    } catch (e) { log('本地 OCR 失败: ' + (e && e.message)); }
  }
  // 2) 远程 OCR（可选）
  if (cfg.ocrUrl) {
    try {
      const r = await fetch(cfg.ocrUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.text && /^[0-9A-Za-z]{3,6}$/.test(j.text.trim())) return j.text.trim();
    } catch {}
  }
  // 免 OCR：把验证码图片弹出来让用户看
  fs.writeFileSync(CAPF, buf);
  try { spawn('cmd', ['/c', 'start', '', CAPF], { detached: true, stdio: 'ignore' }).unref(); } catch {}
  console.log(c('yel', '  （验证码图片已打开：' + CAPF + '）'));
  return (await ask('  请输入图片里的 4 位验证码')).trim();
}

async function login(cfg) {
  for (let a = 0; a < 6; a++) {
   try {
    jar = new Map();
    await req('loginAction.do');
    await sleep(300);
    // 高峰期验证码图片也会很慢 → 25s 超时 + 最多 3 次
    const cap = await req('validateCodeAction.do?random=' + Math.random(), { timeoutMs: 25000, tries: 3 });
    const code = await recognize(Buffer.from(await cap.arrayBuffer()), cfg);
    if (!code) { console.log(c('red', '  没输验证码')); continue; }
    const r = await req('loginAction.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + 'loginAction.do' },
      body: new URLSearchParams({ zjh: cfg.user, mm: cfg.pass, v_yzm: code }).toString(),
    });
    const t = dec(await r.arrayBuffer());
    if (/学分制综合教务/.test(t)) { console.log(c('grn', '✅ 登录成功')); log('登录成功'); return 'ok'; }
    const e = errRow(t);
    if (/您的密码不正确|密码不正确|密码错误|帐号不存在|账号不存在|证件号不存在/.test(e)) {
      console.log(c('red', '❌ 密码不正确（教务提示：' + (e || '—') + '）'));
      log('登录失败: ' + e);
      return 'badpass';
    }
    console.log(c('yel', '  验证码/网络问题，重试…' + (e ? '（教务提示：' + e + '）' : '')));
    await sleep(400);
   } catch (err) {
    log('登录请求异常: ' + (err && err.message));
    console.log(c('yel', '  网络异常（' + ((err && err.name) || '') + '），重试…'));
    await sleep(1200);
   }
  }
  return 'netfail';          // 6 轮都没成 = 网络/验证码问题，交给上层继续重试
}
const isLoginPage = t => /name="v_yzm"/.test(t) || /URP综合教务系统 - 登录/.test(t);
/** 选方案（每个学生的方案号不同，自动识别）；成功后才能拿到选课列表 */
async function selectPlan(cfg) {
  const t = dec(await (await req('xkAction.do')).arrayBuffer());
  if (isLoginPage(t)) return false;
  const plans = [];
  for (const m of t.matchAll(/<input[^>]*>/gi)) {
    const tag = m[0];
    if (!/type=["']?radio/i.test(tag) || !/name=["']?fajhh/i.test(tag)) continue;
    const id = (tag.match(/id=["']([^"']+)/i) || [])[1] || '';
    const val = (tag.match(/value=["']([^"']+)/i) || [])[1] || '';
    const after = t.slice(m.index + tag.length, m.index + tag.length + 120).split('<')[0].replace(/\s+/g, ' ').trim();
    if (val) plans.push({ id, fajhh: val, name: after.slice(0, 40) });
  }
  if (!plans.length) return true;               // 没有方案页 = 已直接进列表
  let pick = plans[0];
  if (plans.length > 1) {
    console.log(c('blu', '检测到多个培养方案：'));
    plans.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p.name + '  (fajhh=' + p.fajhh + ')'));
    const want = process.env.XK_PLAN || (await ask('用哪个？输入序号', '1'));
    pick = plans[Number(want) - 1] || plans[0];
  } else {
    console.log(c('dim', '  方案: ' + pick.name));
  }
  await req('xkAction.do?actionType=-1&fajhh=' + pick.fajhh + '&xdlxdm=' + pick.id);
  log('选方案 ' + pick.fajhh + '/' + pick.id + ' ' + pick.name);
  return true;
}
/** 取登录页 errorTop 单元格的真实提示（登录页里有一段静态模板文字，不能用整页匹配） */
const errRow = t => {
  const m = t.match(/class="errorTop"[^>]*>([\s\S]*?)<\/td>/i);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

// ---------------- 选课 ----------------
function parseRows(html, page) {
  const out = [];
  for (const tr of (html.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const kch = cells.find(x => /^\d{8,10}$/.test(x));
    if (!kch) continue;
    const i = cells.indexOf(kch);
    const cb = tr.match(/name=["']kcId["'][^>]*?(?:id|value)=["']([^"']+)/i);
    out.push({
      kch, kcm: cells[i + 1] || '', kxh: cells[i + 2] || '',
      js: cells[i + 6] || '',
      left: parseInt(String(cells[i + 7] || '').replace(/[^\d-]/g, ''), 10),
      status: cells[i + 9] || '',
      group: (cells[i + 10] || '').replace(/^[;；,，\s]+/, ''),   // 类别：经济与社会类/人文与艺术类…
      kcId: cb ? cb[1] : null, page,
    });
  }
  return out;
}
async function scan(type) {
  const r1 = await req('xkAction.do?actionType=' + type + '&pageNumber=1');
  const t1 = dec(await r1.arrayBuffer());
  if (isLoginPage(t1)) return null;
  let rows = parseRows(t1, 1);
  const pages = Math.min(Number((t1.match(/共\s*(\d+)\s*页/) || [])[1] || 1), 30);
  for (let p = 2; p <= pages; p++) {
    const rp = await req('xkAction.do?actionType=' + type + '&pageNumber=' + p);
    rows = rows.concat(parseRows(dec(await rp.arrayBuffer()), p));
  }
  const seen = new Set();
  return rows.filter(x => { const k = x.kch + '_' + x.kxh; if (seen.has(k)) return false; seen.add(k); return true; });
}
async function enrolled() {
  const r = await req('xkAction.do?actionType=6');
  const t = dec(await r.arrayBuffer());
  if (isLoginPage(t)) return null;
  const out = [];
  for (const tr of (t.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const k = cells.find(x => /^\d{8,10}$/.test(x));
    if (k) out.push({ kch: k, kcm: cells[cells.indexOf(k) + 1] || '' });
  }
  return out;
}
function verdict(html) {
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = plain.match(/(你选择的课程[\s\S]{0,30}?没有课余量|选课成功[^，。；]{0,10}|课余量已满|没有课余量|时间冲突[^，。；]{0,10}|已选过[^，。；]{0,10}|超过[^，。；]{0,15})/);
  const txt = m ? m[1] : '';
  if (/成功/.test(txt)) return { ok: true, txt };
  if (/没有课余量|已满|失败|冲突|已选|超过|不允许/.test(txt)) return { ok: false, txt };
  return { ok: null, txt };
}
async function submit(c, type) {
  const listUrl = 'xkAction.do?actionType=' + type + '&pageNumber=' + (c.page || 1);
  await req(listUrl);                         // 对齐服务端"当前页"
  let v = { ok: null, txt: '' };
  let timedOut = false;
  try {
    const r = await req('xkAction.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + listUrl },
      body: 'preActionType=' + type + '&actionType=9&kcId=' + encodeURIComponent(c.kcId),
      timeoutMs: 25000,
    });
    v = verdict(dec(await r.arrayBuffer()));
  } catch (e) {
    // ★ 高峰期提交可能超时——结果未知，绝不能当失败，先回查课表
    timedOut = true;
    log('提交超时/异常: ' + (e && e.message));
    console.log(c('yel', '       提交请求超时，2 秒后回查课表确认是否已选上…'));
    await sleep(2000);
  }
  const list = await enrolledSafe();
  const got = list ? list.some(x => x && x.kch === c.kch) : false;   // 按课程号精确判定
  if (timedOut && got) v = { ok: true, txt: '（提交超时，但课表已确认选上）' };
  return { v, got, list };
}

/** 选方案（带重试，绝不抛错） */
async function selectPlanSafe(cfg) {
  for (let i = 1; i <= 3; i++) {
    try { return await selectPlan(cfg); }
    catch (e) { log('选方案异常: ' + (e && e.message)); console.log(c('yel', '  选方案失败，重试 ' + i + '/3…')); await sleep(1000 * i); }
  }
  return false;
}
const CATNAME = { '1': '计划课程', '2': '方案课程', '3': '校任选课', '4': '系任选课', '5': '自由选择', '14': '重修课程' };
/** 按配置扫多个分类，给每行打上 cat 标签；全失败返回 null */
async function scanAllCfg(cfg) {
  const types = (cfg.types && cfg.types.length ? cfg.types : [cfg.type || '3']).map(String);
  let all = [], anyOk = false;
  for (const t of types) {
    const r = await scanSafe(t);
    if (r === null) continue;
    anyOk = true;
    if (!r.length) { console.log(c('dim', '  ' + (CATNAME[t] || t) + '：当前没有课程')); continue; }
    all = all.concat(r.map(x => ({ ...x, cat: t })));
  }
  return anyOk ? all : null;
}
/** 扫描（带重试，绝不抛错；返回 null 表示会话可能失效） */
async function scanSafe(type) {
  for (let i = 1; i <= 3; i++) {
    try { return await scan(type); }
    catch (e) { log('扫描异常: ' + (e && e.message)); console.log(c('yel', '  扫描失败，重试 ' + i + '/3…')); await sleep(800 * i); }
  }
  return null;
}
/** 已选清单（带重试，绝不抛错） */
async function enrolledSafe() {
  for (let i = 1; i <= 3; i++) {
    try { return await enrolled(); }
    catch (e) { log('查课表异常: ' + (e && e.message)); await sleep(700 * i); }
  }
  return null;
}

/** 处理一门课：打印 → 通知 → 提交。返回 true 表示抢到了（应结束） */
async function tryOne(x, label, cfg, notified) {
  const can = x.kcId && x.left > 0;
  const tag = can ? c('grn', '✅ 可抢') : (x.left > 0 ? c('yel', '⛔ 受限') : c('red', '❌ 已满'));
  console.log('  ' + label + ' ' + (x.kch + '_' + x.kxh).padEnd(16) + (x.kcm || '').padEnd(13) +
    (x.group ? c('blu', '[' + x.group + ']') : '') + ' 余量 ' + String(x.left).padStart(4) + '  ' + tag);
  if (!can) return false;
  const key = x.kch + '_' + x.kxh;
  const firstTime = !notified.has(key);
  if (firstTime) {
    notified.add(key);
    notify('余量出现！', (x.group ? x.group + ' · ' : '') + x.kcm + '（' + x.kch + '_' + x.kxh + '）余量 ' + x.left + '，赶紧去选！');
    log('发现余量: ' + key + ' ' + x.kcm + ' 余量=' + x.left + (x.group ? ' 类别=' + x.group : ''));
  }
  if (cfg.mode !== 'auto') {
    console.log(c('yel', '     → 只提醒模式：不提交，' + (firstTime ? '已弹窗+响铃，去教务手点即可。' : '（已通知过）')));
    return false;
  }
  console.log(c('red', '     → 自动抢：提交中…'));
  const { v, got, list } = await submit(x, x.cat || cfg.type);
  log('提交 ' + key + ' → ' + (v.txt || '(无提示)') + ' 课表' + (list ? list.length : '?') + '门');
  console.log('       教务回复: ' + (v.txt || '(未识别)'));
  if (got || v.ok) {
    console.log(c('grn', '\n🎉 抢课成功：' + x.kch + ' ' + x.kcm + (x.group ? '（' + x.group + '）' : '') + '（课表现在 ' + (list ? list.length : '?') + ' 门）'));
    notify('抢课成功 🎉', x.kcm + ' 已选上，请尽快去教务确认。');
    return true;
  }
  console.log(c('dim', '       未成功：' + (v.txt || '（可能已被抢走）') + '，继续盯…'));
  return false;
}

/** 密码错了：当场重输（可选择保存），不退出 */
async function fixPassword(cfg) {
  console.log(c('red', '\n❌ 教务密码不正确（注意：不是 VPN 密码）'));
  const np = await askSecret('请重新输入教务密码（直接回车 = 退出程序）: ');
  if (!np) return false;
  cfg.pass = np;
  const save = (await ask('要把新密码保存到 config.json 吗？(y/N)', 'n')).trim().toLowerCase();
  if (save.startsWith('y')) { cfg.rememberPass = true; saveCfg(cfg); console.log(c('grn', '✅ 已保存到 config.json')); }
  return true;
}

// ---------------- 主循环 ----------------
async function main() {
  console.log(c('mag', '\n╔══════════════════════════════════════════╗'));
  console.log(c('mag', '║ 教务抢课助手 · 同学版 v1.7 可挂着等   ║'));
  console.log(c('mag', '╚══════════════════════════════════════════╝'));
  console.log(c('dim', '本工具仅用于自己的账号；用脚本抢课可能违反校规，请自行判断风险。\n'));

  let cfg = loadCfg();
  // 高级用法/测试：环境变量可覆盖配置（不会写盘）
  const envCfg = {};
  if (process.env.XK_USER) envCfg.user = process.env.XK_USER;
  if (process.env.XK_PASS) envCfg.pass = process.env.XK_PASS;
  if (process.env.XK_CANDS) envCfg.candidates = process.env.XK_CANDS.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.XK_MODE) envCfg.mode = process.env.XK_MODE;
  if (process.env.XK_TYPES) envCfg.types = process.env.XK_TYPES.split(',').map(s => s.trim()).filter(Boolean);
  if (process.env.XK_GROUP) envCfg.group = process.env.XK_GROUP;
  if (process.env.XK_TEACHER) envCfg.teacher = process.env.XK_TEACHER;
  if (process.env.XK_OCR) envCfg.ocrUrl = process.env.XK_OCR;
  if (process.env.XK_INTERVAL) envCfg.interval = Number(process.env.XK_INTERVAL);
  if (Object.keys(envCfg).length) cfg = { ...(cfg || DEFAULT_CFG), ...envCfg };
  const maxRounds = Number(process.env.XK_ROUNDS || 0);
  if (!cfg || !cfg.user) { cfg = { ...(await wizard()), ...envCfg }; }   // 向导结果仍可被环境变量覆盖
  const hasFilter = !!((cfg.group || '').trim() || (cfg.teacher || '').trim());
  if ((!cfg.candidates || !cfg.candidates.length) && !hasFilter) {
    console.log(c('red', 'config.json 里 candidates 为空，且没设 group/teacher 筛选。'));
    console.log(c('dim', '   → 填 candidates（课程号或课名），或填 group（如 人文与艺术类）/ teacher（如 紫金慕课）'));
    return;
  }
  if (!cfg.pass) {
    cfg.pass = await askSecret('请输入教务密码（不保存）: ');
    if (!cfg.pass) { console.log(c('red', '没密码没法登录')); return; }
  }
  const interval = Math.max(MIN_INTERVAL, Number(cfg.interval) || 3);

  console.log('\n学号: ' + cfg.user);
  console.log('候选: ' + ((cfg.candidates && cfg.candidates.length) ? cfg.candidates.join(' → ') : c('dim', '(未指定，用筛选)')));
  if (hasFilter) console.log('筛选: ' + (cfg.teacher || '任意老师') + ' · ' + (cfg.group || '任意类别'));
  console.log('模式: ' + (cfg.mode === 'auto' ? c('red', '自动抢（会真提交）') : c('grn', '只提醒（不提交）')));
  if (cfg.mode === 'auto') {
    const raw = (await ask(c('red', '自动抢会真的提交选课！确认请输入 YES'), '')).trim();
    const ok = raw.toUpperCase();
    if (ok !== 'YES' && ok !== 'Y') {
      console.log(c('yel', '已取消自动抢（你输入的是「' + raw + '」），改为只提醒模式。'));
      cfg.mode = 'watch';
    } else {
      console.log(c('red', '⚠️ 已开启自动抢：发现余量会直接提交'));
    }
  }

  const hasLocalOcr = await initLocalOcr();
  console.log('验证码识别: ' + (hasLocalOcr ? c('grn', '本地模型自动识别') : c('yel', '手动输入（未找到 model 目录）')));
  if (cfg.autoHost) {
    try { await speedTest(cfg.hosts); }
    catch (e) { log('测速异常: ' + (e && e.message)); console.log(c('yel', '测速出错，直接用默认节点硬上')); }
  }
  // 登录：网络问题就一直重试，绝不因为"等不到"而退出
  for (let n = 1; ; n++) {
    const st = await login(cfg).catch(() => 'netfail');
    if (st === 'ok') break;
    if (st === 'badpass') {
      if (!(await fixPassword(cfg))) { console.log(c('dim', '已退出。')); return; }
      n = 0;                      // 重输后重新计数
      continue;
    }
    const wait = Math.min(30000, 5000 * n);
    console.log(c('yel', '登录未成功（第 ' + n + ' 次尝试），' + Math.round(wait / 1000) + ' 秒后继续…'));
    await sleep(wait);
  }
  if (!(await selectPlanSafe(cfg))) console.log(c('yel', '选方案没成功，先进轮询，稍后会自动重试'));

  const started = Date.now();
  let round = 0, notifiedFor = new Set(), emptyStreak = 0;
  console.log(c('dim', '\n开始轮询（Ctrl+C 退出）…\n'));
  for (;;) {
    round++;
    if (maxRounds && round > maxRounds) { console.log(c('dim', '\n（已达轮数上限 ' + maxRounds + '，退出）')); return; }
   try {
    let rows = await scanAllCfg(cfg);
    if (!rows) {
      console.log(c('yel', '会话失效或网络异常，重新登录…'));
      const st = await login(cfg).catch(() => 'netfail');
      if (st === 'badpass') {
        if (!(await fixPassword(cfg))) { console.log(c('dim', '已退出。')); return; }
        await sleep(500);
        continue;
      }
      if (st !== 'ok') { await sleep(5000); continue; }     // 网络问题：下一轮接着来
      await selectPlanSafe(cfg);
      rows = await scanAllCfg(cfg) || [];
    }
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const mins = Math.floor((Date.now() - started) / 60000);
    if (!rows.length) {
      // ★ 选课没开放/页面打不开：不退出、不刷屏，放慢节奏静静等
      emptyStreak++;
      if (emptyStreak === 1 || emptyStreak % 10 === 0) {
        console.log(c('dim', '── 第 ' + round + ' 轮 ' + ts + ' · 已运行 ' + mins + ' 分'));
        console.log(c('yel', '  ⏳ 列表为空（第 ' + emptyStreak + ' 轮）：选课可能还没开放，程序会一直等下去，不用管它'));
      }
    } else {
      if (emptyStreak > 0) console.log(c('grn', '  ✅ 列表有数据了（之前空了 ' + emptyStreak + ' 轮），恢复正常速度'));
      emptyStreak = 0;
      console.log(c('dim', '── 第 ' + round + ' 轮  ' + ts + '  ·  ' + rows.length + ' 门课  ·  已运行 ' + mins + ' 分') );
    }
    const wantG = (cfg.group || '').trim(), wantT = (cfg.teacher || '').trim();
    const byFilter = (wantG || wantT) && !(cfg.candidates || []).length;
    if (!rows.length) {
      // 空列表已经在上面提示过，这里不重复刷候选（提前开跑时要能挂几个小时）
    } else if (byFilter) {
      const matched = rows.filter(r => (!wantG || (r.group || '').includes(wantG)) && (!wantT || (r.js || '').includes(wantT)));
      const avail = matched.filter(r => r.kcId && r.left > 0);
      console.log('  【筛选】' + (wantT || '任意老师') + ' · ' + (wantG || '任意类别') +
        ' → 符合 ' + matched.length + ' 门，可选 ' + avail.length + ' 门');
      if (!matched.length) console.log(c('dim', '     （没有符合条件的课：检查类别名/老师名，或选课批次未放量）'));
      const pool = avail.length ? avail.slice(0, 3) : matched.slice(0, 3);
      for (const x of pool) if (await tryOne(x, '•', cfg, notifiedFor)) return;
    } else {
      for (let ti = 0; ti < cfg.candidates.length; ti++) {
        const q = cfg.candidates[ti];
        const hit = rows.filter(r => r.kch === q || (r.kcm && r.kcm.includes(q)));
        if (!hit.length) { console.log('  ' + (ti + 1) + '. ' + q.padEnd(16) + c('dim', '不在本轮列表')); continue; }
        for (const x of hit) if (await tryOne(x, (ti + 1) + '.', cfg, notifiedFor)) return;
      }
    }
   } catch (err) {
    log('轮询异常: ' + (err && err.message));
    console.log(c('yel', '  本轮异常（' + ((err && err.name) || '') + '），稍后继续…'));
   }
    // 列表为空/异常时逐步降频，最多 60 秒一轮；一有数据立刻恢复
    const slow = emptyStreak > 0 ? Math.min(20, 1 + Math.floor(emptyStreak / 3)) : 1;
    await sleep(Math.min(60000, interval * 1000 * slow) + Math.floor(Math.random() * 1200));
  }
}

process.on('SIGINT', () => { console.log('\n已退出。日志在 ' + LOGF); process.exit(0); });

// ★ 顶层兜底：任何未预料的异常都不退出，10 秒后自动重来
(async () => {
  for (let attempt = 1; ; attempt++) {
    try { await main(); return; }
    catch (e) {
      log('主流程异常: ' + (e && e.stack ? e.stack : e));
      console.error(c('red', '出错了：' + (e && e.message ? e.message : e)));
      console.error(c('yel', '10 秒后自动重来（第 ' + attempt + ' 次）… Ctrl+C 可退出'));
      await sleep(10000);
    }
  }
})();
