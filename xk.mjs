#!/usr/bin/env node
/**
 * 教务 URP 抢课工具（侦察 + 抢课）
 * --------------------------------------------------------------
 * 默认安全策略：
 *   - 所有 POST 默认「干跑（dry-run）」，只打印将要提交的内容，不发请求；
 *   - 只有显式加 --live 才会真的提交；
 *   - 抓课默认 3 秒一次、带抖动，不做高频刷。
 *
 * 用法：
 *   node xk.mjs login                     登录 + 打印首页里与「选课」相关的入口
 *   node xk.mjs menu                      复用会话，列出菜单链接
 *   node xk.mjs dump <path|url> [--raw]   抓页面（GBK→UTF8），列表单与链接
 *   node xk.mjs post <path> --data k=v ... [--live]
 *   node xk.mjs grab --course <关键字> [--interval 3] [--max 100] [--live]
 *
 * 凭据（不要写在命令行历史里）：
 *   export URP_USER=学号 URP_PASS=密码
 *   export URP_BASE=http://192.168.16.207     # 默认
 *   export OCR_URL=http://127.0.0.1:5003/ocr  # 若本机没有 OCR，用 ssh -L 5003:127.0.0.1:5003 your-ocr-host 转发
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

// 自动读取同目录 .env（避免把凭据写进命令行历史）
try {
  const envTxt = fs.readFileSync(path.resolve('.env'), 'utf8');
  for (const line of envTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

let BASE = (() => {
  try { const h = fs.readFileSync(path.resolve('.urp-host'), 'utf8').trim(); if (h) return h; } catch {}
  return (process.env.URP_BASE || 'http://192.168.16.207').replace(/\/+$/, '') + '/';
})();
const OCR = process.env.OCR_URL || 'http://127.0.0.1:5003/ocr';
const USER = process.env.URP_USER || '';
const PASS = process.env.URP_PASS || '';
const COOKIE_FILE = path.join(process.cwd(), '.urp-cookies.json');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (name) => argv.includes('--' + name);
const opt = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const allOpt = (name) => {
  const out = [];
  argv.forEach((a, i) => { if (a === '--' + name && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
};
const LIVE = flag('live');

let jar = new Map();
const loadJar = () => { try { jar = new Map(Object.entries(JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')))); } catch {} };
const saveJar = () => { try { fs.writeFileSync(COOKIE_FILE, JSON.stringify(Object.fromEntries(jar), null, 2)); } catch {} };
const cookieHeader = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const storeCookies = (res) => {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.raw?.()['set-cookie'] || []);
  for (const c of list) {
    const first = String(c).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function req(p, opts = {}) {
  const url = /^https?:/.test(p) ? p : BASE + p.replace(/^\/+/, '');
  const headers = { 'User-Agent': UA, Referer: BASE, ...(opts.headers || {}) };
  if ((opts.method || 'GET').toUpperCase() !== 'GET') headers.Origin = BASE.replace(/\/$/, '');
  if (jar.size) headers.Cookie = cookieHeader();
  const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
  storeCookies(res); saveJar();
  return res;
}
async function bodyText(res) {
  const ab = await res.arrayBuffer();
  try { return new TextDecoder('gbk').decode(ab); } catch { return new TextDecoder('utf-8').decode(ab); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function recognize(imgBytes) {
  try {
    const r = await fetch(OCR, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: imgBytes });
    const j = await r.json();
    if (j.text && /^[0-9A-Za-z]{3,6}$/.test(j.text.trim())) return j.text.trim();
    console.log('  OCR 结果异常:', JSON.stringify(j).slice(0, 120));
  } catch (e) {
    console.log('  OCR 服务不可用（' + e.message + '），改用人工输入');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('  请输入验证码: ')).trim();
  rl.close();
  return ans;
}

async function login({ quiet = false } = {}) {
  if (!USER || !PASS) { console.error('缺少凭据：请先 export URP_USER= 学号  URP_PASS= 密码'); process.exit(2); }
  for (let attempt = 1; attempt <= 5; attempt++) {
    jar = new Map();
    await req('loginAction.do');
    await sleep(400);
    const cap = await req('validateCodeAction.do?random=' + Math.random());
    const code = await recognize(Buffer.from(await cap.arrayBuffer()));
    if (!quiet) console.log('  验证码:', code);
    const form = new URLSearchParams({ zjh: USER, mm: PASS, v_yzm: code });
    const res = await req('loginAction.do', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + 'loginAction.do' },
      body: form.toString(),
    });
    const html = await bodyText(res);
    const e = errRowOf(html);
    if (/您的密码不正确|密码不正确|密码错误|帐号不存在|账号不存在|证件号不存在/.test(e)) {
      console.error('❌ 密码不正确（教务提示：' + (e || '—') + '）'); process.exit(1);
    }
    console.log('  验证码/网络问题，重试…' + (e ? '（' + e + '）' : '')); await sleep(500); continue;
    console.log('✅ 登录成功（第 ' + attempt + ' 次）');
    return true;
  }
  console.error('❌ 多次验证码失败');
  process.exit(1);
}

function pickLinks(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1], text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text) out.push({ href, text });
  }
  return out;
}
function formsOf(html) {
  const out = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1], inner = m[2];
    const get = (k) => (attrs.match(new RegExp(k + '\\s*=\\s*["\']([^"\']*)', 'i')) || [])[1] || '';
    const inputs = [];
    const ir = /<(input|select|textarea)\b([^>]*)>/gi;
    let x;
    while ((x = ir.exec(inner))) {
      const a = x[2] || '';
      const nm = (a.match(/name\s*=\s*["']([^"']+)["']/i) || [])[1];
      const vl = (a.match(/value\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
      const tp = (a.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1] || x[1];
      if (nm) inputs.push({ name: nm, type: tp, value: vl });
    }
    out.push({ action: get('action'), method: (get('method') || 'GET').toUpperCase(), inputs });
  }
  return out;
}

async function cmdLogin() {
  await login();
  const res = await req('loginAction.do');
  const html = await bodyText(res);
  const links = pickLinks(html);
  const kw = links.filter(l => /选课|选课管理|选课|补选|退课|课/.test(l.text));
  console.log('\n=== 登录后页面里的相关入口（共 ' + links.length + ' 个链接）===');
  (kw.length ? kw : links).slice(0, 40).forEach(l => console.log('  ' + l.text.slice(0, 40) + '  →  ' + l.href));
  fs.writeFileSync('login-page.html', html);
  console.log('\n完整页面已存到 login-page.html');
}

async function cmdMenu() {
  loadJar();
  if (!jar.size) { console.log('会话不存在，先 login'); return; }
  for (const p of ['loginAction.do', 'self.do', 'list.do', 'index.jsp', 'main.jsp']) {
    try {
      const res = await req(p);
      if (res.status !== 200) { console.log(p + ' → HTTP ' + res.status); continue; }
      const html = await bodyText(res);
      const links = pickLinks(html);
      const hit = links.filter(l => /选课|退课|课/.test(l.text));
      console.log('\n[' + p + '] 链接 ' + links.length + ' 个，相关 ' + hit.length + ' 个');
      hit.slice(0, 30).forEach(l => console.log('   ' + l.text.slice(0, 40) + '  →  ' + l.href));
    } catch (e) { console.log(p + ' 失败: ' + e.message); }
  }
}

async function cmdDump() {
  loadJar();
  const target = argv[1];
  if (!target) { console.log('用法: node xk.mjs dump <path|url>'); return; }
  const res = await req(target);
  const html = await bodyText(res);
  const name = 'dump-' + Date.now() + '.html';
  fs.writeFileSync(name, html);
  console.log('HTTP ' + res.status + '，长度 ' + html.length + '，已存 ' + name);
  const fs2 = formsOf(html);
  console.log('\n=== 表单 ===');
  fs2.slice(0, 10).forEach((f, i) => {
    console.log(' [' + i + '] ' + f.method + ' ' + (f.action || '(同当前页)'));
    f.inputs.slice(0, 20).forEach(inp => console.log('      ' + inp.name + ' (' + inp.type + ') = ' + String(inp.value).slice(0, 40)));
  });
  const links = pickLinks(html).filter(l => /选|课|提交|确认/.test(l.text));
  console.log('\n=== 相关链接 ===');
  links.slice(0, 30).forEach(l => console.log('  ' + l.text.slice(0, 40) + '  →  ' + l.href));
}

async function cmdPost() {
  loadJar();
  const target = argv[1];
  if (!target) { console.log('用法: node xk.mjs post <path> --data k=v [--live]'); return; }
  const data = allOpt('data');
  const body = data.join('&');
  console.log((LIVE ? '⚡ LIVE 提交' : '🧪 DRY-RUN（不会真的提交）') + ': POST ' + target);
  console.log('  body: ' + body);
  if (!LIVE) { console.log('\n（确认无误后加 --live 才会真的发出去）'); return; }
  const res = await req(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + target },
    body,
  });
  const html = await bodyText(res);
  fs.writeFileSync('post-result-' + Date.now() + '.html', html);
  console.log('HTTP ' + res.status + '，返回 ' + html.length + ' 字节（已存文件）');
  const brief = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log('摘要: ' + brief.slice(0, 400));
}

// ---------- 抢课 ----------
function dec(ab) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(ab); }
  catch { return new TextDecoder('gbk').decode(ab); }
}
/** 解析选课列表页的课程行：课程号/课程名/课序号/教师/课余量；无勾选框 = 不可选 */
function parseCourseRows(html, page = 1) {
  const out = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m =>
      m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
    const kch = cells.find(c => /^\d{8,10}$/.test(c));
    if (!kch) continue;
    const i = cells.indexOf(kch);
    const cb = tr.match(/name=["']kcId["'][^>]*?(?:id|value)=["']([^"']+)/i);
    out.push({
      kch,
      kcm: cells[i + 1] || '',
      kxh: cells[i + 2] || '',
      js: cells[i + 6] || '',
      left: parseInt(String(cells[i + 7] || '').replace(/[^\d-]/g, ''), 10),
      kcId: cb ? cb[1] : null,
      page,
    });
  }
  return out;
}

/** 列表页「共 N 页」 */
function totalPages(html) {
  const m = html.match(/共\s*(\d+)\s*页/);
  return m ? Math.min(Number(m[1]), 50) : 1;
}
/** 解析提交返回里的 alert 文案（URP 选课成功/失败都是浏览器弹窗） */
const STATIC_ALERTS = new Set(['请输入要跳转的页面！', '请选择方案名称后点击网上选课按钮']);
/** 登录页 errorTop 的真实提示（页内另有静态模板文字，不能整页匹配） */
const errRowOf = t => {
  const m = t.match(/class="errorTop"[^>]*>([\s\S]*?)<\/td>/i);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '';
};
function parseAlerts(html) {
  return [...html.matchAll(/alert\s*\(\s*["']([\s\S]{0,200}?)["']\s*\)/gi)]
    .map(m => m[1].replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(a => a && !STATIC_ALERTS.has(a));
}
/** 提交结果判定：URP 把提示写在返回页正文里（不是 alert），也可能两者都有 */
function submitVerdict(html) {
  const alerts = parseAlerts(html);
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                     .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                     .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = plain.match(/(你选择的课程[^，。；]{0,40}|选课成功[^，。；]{0,20}|没有课余量|课余量已满|时间冲突[^，。；]{0,15}|已选[^，。；]{0,15}|超过[^，。；]{0,20})/);
  const text = [...alerts, m ? m[1] : ''].filter(Boolean).join(' / ');
  if (/成功/.test(text)) return { ok: true, text };
  if (/没有课余量|课余量已满|失败|不足|冲突|已选|上限|超过|不允许|不能/.test(text)) return { ok: false, text };
  return { ok: null, text };
}
/** 已选课程清单（actionType=6 的明细表，慕课也在里面，比周网格可靠） */
async function enrolledList() {
  const r = await req('xkAction.do?actionType=6');
  const t = dec(await r.arrayBuffer());
  const out = [];
  for (const tr of (t.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const kch = cells.find(c => /^\d{8,10}$/.test(c));
    if (kch) out.push({ kch, kcm: cells[cells.indexOf(kch) + 1] || '' });
  }
  return out;
}

/** 顺序（绝不并发）测各教务 IP：只用 GET 登录页，不登录 → 不会互踢会话 */
async function probeHosts(hosts) {
  const out = [];
  for (const h of hosts) {
    const base = /^https?:/.test(h) ? h.replace(/\/+$/, '') + '/' : 'http://' + h.replace(/\/+$/, '') + '/';
    const samples = []; let err = '';
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch(base + 'loginAction.do', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
        const ab = await r.arrayBuffer();
        if (!r.ok) { err = 'HTTP ' + r.status; break; }
        if (ab.byteLength < 500) { err = '内容异常(' + ab.byteLength + 'B)'; break; }
        samples.push(performance.now() - t0);
      } catch (e) { err = e.name === 'TimeoutError' ? '超时' : e.message.slice(0, 30); break; }
      await sleep(150);
    }
    out.push({ host: h, base, ok: samples.length > 0 && !err, best: samples.length ? Math.min(...samples) : Infinity, avg: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : Infinity, n: samples.length, err });
  }
  out.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.best - b.best));
  return out;
}
function printHostTable(res) {
  res.forEach((r, i) => console.log('  ' + (i + 1) + ') ' + r.host.padEnd(17) +
    (r.ok ? '✅ 最快 ' + Math.round(r.best) + 'ms  平均 ' + Math.round(r.avg) + 'ms（' + r.n + ' 次）' : '❌ ' + (r.err || '不可用'))));
}
function setBase(base) {
  BASE = base.replace(/\/+$/, '') + '/';
  jar = new Map(); saveJar();                    // 换主机 → 旧会话作废，必须重新登录
  try { fs.writeFileSync(path.resolve('.urp-host'), BASE); } catch {}
}
/** 对单门课执行提交（或 dry-run）。返回 'success' | 'dry' | 'fail' */
async function attemptCourse(c, type) {
  const body = 'preActionType=' + type + '&actionType=9&kcId=' + encodeURIComponent(c.kcId);
  const listUrl = 'xkAction.do?actionType=' + type + '&pageNumber=' + (c.page || 1);
  if (!LIVE) {
    console.log('\n🧪 DRY-RUN：命中可抢，以下是**将要发送**的请求（未发送）：');
    console.log('   POST ' + BASE + 'xkAction.do');
    console.log('   Content-Type: application/x-www-form-urlencoded');
    console.log('   Origin: ' + BASE.replace(/\/$/, ''));
    console.log('   Referer: ' + BASE + listUrl);
    console.log('   body: ' + body);
    console.log('\n   加 --live 才会真的提交（提交后会自动复核课表）。');
    return 'dry';
  }
  console.log('  ⚡ 提交中…（先把会话对齐到该课所在第 ' + (c.page || 1) + ' 页）');
  await req(listUrl);                             // ★ 让服务端"当前页"= 该课所在页
  const r2 = await req('xkAction.do', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + listUrl }, body });
  const t2 = dec(await r2.arrayBuffer());
  fs.writeFileSync('grab-result-' + Date.now() + '.html', t2);
  const cls = submitVerdict(t2);
  console.log('    教务回复: ' + (cls.text || '(未识别)'));
  const list = await enrolledList();
  const got = list.some(x => x.kch === c.kch || (x.kcm && x.kcm.includes(c.kcm)));
  if (got || cls.ok === true) {
    console.log('    复核已选清单: ✅ 已存在（共 ' + list.length + ' 门）');
    console.log('\n🎉 抢课成功：' + c.kch + ' ' + c.kcm);
    return 'success';
  }
  console.log('    复核已选清单: ❌ 未进入（共 ' + list.length + ' 门）');
  return 'fail';
}

async function cmdSpeed() {
  const hosts = (opt('hosts', '192.168.16.207,192.168.16.208,192.168.16.209')).split(',').map(s => s.trim()).filter(Boolean);
  console.log('=== 教务 IP 测速（顺序逐个，不并发、不登录 → 不会互踢会话）===');
  const res = await probeHosts(hosts);
  printHostTable(res);
  const win = res.find(r => r.ok);
  if (win) { setBase(win.base); console.log('\n✅ 已记录最快节点: ' + BASE + '（下次 grab 自动用它）'); }
  else console.log('\n❌ 没有可用节点');
}

async function cmdGrab() {
  const targets = allOpt('course');
  const type = opt('type', '3');            // 3=校任选 4=系任选 5=自由选择 1=计划课程 14=重修
  const interval = Number(opt('interval', '3'));
  const maxTries = Number(opt('max', '200'));
  const plan = opt('plan', '4951');
  const planId = opt('planid', '00001');
  if (!targets.length) {
    console.log('用法: node xk.mjs grab --course <候选1> [--course <候选2> ...] [--type 3] [--auto-host] [--live]');
    console.log('   多个 --course = 优先级顺序：第一个满了/没了自动试下一个');
    return;
  }
  // 0) 顺序测速选最快节点（不并发、不登录 → 不会互踢会话）
  if (flag('auto-host')) {
    const hosts = (opt('hosts', '192.168.16.207,192.168.16.208,192.168.16.209')).split(',').map(s => s.trim()).filter(Boolean);
    console.log('=== 教务 IP 测速（顺序逐个，不并发、不登录）===');
    const res = await probeHosts(hosts);
    printHostTable(res);
    const win = res.find(r => r.ok);
    if (!win) { console.log('\n❌ 没有可用节点'); return; }
    setBase(win.base);
    console.log('✅ 采用 ' + BASE + '（后续所有请求走它）');
  }
  loadJar();
  if (!jar.size) await login({ quiet: true });
  await req('xkAction.do?actionType=-1&fajhh=' + plan + '&xdlxdm=' + planId);  // 选方案（GET，无副作用）
  console.log('=== 候选课（按优先级）: ' + targets.join(' → ') + '（类别 actionType=' + type + '）===');
  console.log('   节点: ' + BASE);
  console.log('   模式: ' + (LIVE ? '⚡ LIVE 会真的提交' : '🧪 DRY-RUN 只观察，绝不提交') +
    '   轮询: ' + interval + 's±抖动   上限: ' + maxTries + ' 次');
  for (let n = 1; n <= maxTries; n++) {
    let rows = [];
    try {
      // 注意：pageNumber=-1 是「最后一页」，不是第 1 页（实测），必须从 1 开始顺序扫
      const res = await req('xkAction.do?actionType=' + type + '&pageNumber=1');
      const t1 = dec(await res.arrayBuffer());
      rows = parseCourseRows(t1, 1);
      const pages = totalPages(t1);
      for (let p = 2; p <= pages; p++) {
        const rp = await req('xkAction.do?actionType=' + type + '&pageNumber=' + p);
        rows = rows.concat(parseCourseRows(dec(await rp.arrayBuffer()), p));
      }
      // 去重（分页/嵌套表格会导致同一课程重复出现）
      const seen = new Set();
      rows = rows.filter(r => { const k = r.kch + '_' + r.kxh; if (seen.has(k)) return false; seen.add(k); return true; });
      if (n === 1) console.log('   （共 ' + pages + ' 页，扫到 ' + rows.length + ' 门课）');
    } catch (e) { console.log('  抓取失败: ' + e.message); }
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 按优先级依次尝试候选：第一个满了/没了就试下一个
    for (let ti = 0; ti < targets.length; ti++) {
      const target = targets[ti];
      const hit = rows.filter(r => r.kch === target || r.kcm.includes(target));
      if (!hit.length) {
        console.log('  [' + n + ' ' + ts + '] 候选' + (ti + 1) + '/' + targets.length + '「' + target + '」不在本轮列表里');
        continue;
      }
      // 防选错：一个候选匹配到多个可选课 → 拒绝提交
      const cand = hit.filter(r => r.kcId && r.left > 0);
      if (cand.length > 1) {
        console.log('\n⚠️ 候选' + (ti + 1) + ' 匹配到 ' + cand.length + ' 个可选课程，为防选错**拒绝提交**：');
        cand.forEach(r => console.log('   --course ' + r.kch + '   (' + r.kch + '_' + r.kxh + ' ' + r.kcm + ' | ' + r.js + ' | 余量=' + r.left + ')'));
        return;
      }
      for (const c of hit) {
        const state = (c.kcId && c.left > 0) ? '✅ 可选' : (c.left > 0 ? '⛔ 有余量但受限' : '❌ 已满');
        console.log('  [' + n + ' ' + ts + '] 候选' + (ti + 1) + '/' + targets.length + ' ' + c.kch + '_' + c.kxh + ' ' + c.kcm + ' | ' + c.js + ' | 余量=' + c.left + ' | ' + state);
        if (c.kcId && c.left > 0) {
          const r = await attemptCourse(c, type);
          if (r === 'success') return;
          if (r === 'dry') return;
        }
      }
    }
    if (n < maxTries) await sleep(interval * 1000 + Math.floor(Math.random() * 1500));
  }
  console.log('\n轮询 ' + maxTries + ' 次结束，未抢到。');
}

const h = () => console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));

try {
  if (cmd === 'login') await cmdLogin();
  else if (cmd === 'menu') await cmdMenu();
  else if (cmd === 'dump') await cmdDump();
  else if (cmd === 'post') await cmdPost();
  else if (cmd === 'grab') await cmdGrab();
  else if (cmd === 'speed') await cmdSpeed();
  else h();
} catch (e) {
  console.error('出错: ' + (e && e.message ? e.message : e));
  process.exit(1);
}
