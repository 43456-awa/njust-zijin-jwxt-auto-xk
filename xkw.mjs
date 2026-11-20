#!/usr/bin/env node
/**
 * 教务抢课助手 · 本地网页版
 * 双击 exe → 起一个只监听 127.0.0.1 的小服务 → 自动打开浏览器
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { initOcr, recognizeJpeg } from './ocr.mjs';

const DIR = (() => {
  try { if (process.versions && process.versions.bun) return path.dirname(process.execPath); } catch {}
  return path.dirname(process.argv[1] ? path.resolve(process.argv[1]) : process.cwd());
})();
const CFG = path.join(DIR, 'config.json');
const PAGEF = path.join(DIR, 'page.html');
const LOGF = path.join(DIR, 'xk.log');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_INTERVAL = 3;

const DEFAULTS = {
  user: '', pass: '', candidates: [], group: '', teacher: '',
  types: ['3'], type: '3', interval: 3, mode: 'watch', autoHost: true,
  hosts: ['jw.example.edu', 'jw2.example.edu', 'jw3.example.edu'],
};
const CATNAME = { '1': '计划课程', '2': '方案课程', '3': '校任选课', '4': '系任选课', '5': '自由选择', '14': '重修课程' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = {
  running: false, phase: 'idle', round: 0, startedAt: 0, node: '', lastError: '',
  rows: [], matched: [], logs: [], captured: [], needCaptcha: false, cfg: null, catNotes: {}, scanRows: [],
};
function log(line) {
  const s = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + line;
  try { fs.appendFileSync(LOGF, s + '\n'); } catch {}
  S.logs.push(s); if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);
}
const loadCfg = () => { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch { return { ...DEFAULTS }; } };
const saveCfg = c => { try { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); } catch {} };

let ocrReady = false, stopFlag = false, captchaResolver = null, lastCaptchaBuf = null;

// ---------------- 网络 ----------------
let BASE = 'http://jw.example.edu/';
let jar = new Map();
const ck = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
const store = r => {
  const l = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const cc of l) { const f = cc.split(';')[0]; const i = f.indexOf('='); if (i > 0) jar.set(f.slice(0, i), f.slice(i + 1)); }
};
const dec = ab => { try { return new TextDecoder('utf-8', { fatal: true }).decode(ab); } catch { return new TextDecoder('gbk').decode(ab); } };
async function req(p, o = {}) {
  const url = /^https?:/.test(p) ? p : BASE + p.replace(/^\/+/, '');
  const method = (o.method || 'GET').toUpperCase();
  const h = { 'User-Agent': UA, Referer: BASE, ...(o.headers || {}) };
  if (method !== 'GET') h.Origin = BASE.replace(/\/$/, '');
  if (jar.size) h.Cookie = ck();
  const tries = o.tries || (method === 'GET' ? 3 : 1);
  const timeoutMs = o.timeoutMs || (method === 'GET' ? 12000 : 20000);
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { method, headers: h, redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs), ...(o.body !== undefined ? { body: o.body } : {}) });
      store(r); return r;
    } catch (e) {
      log('请求失败 ' + i + '/' + tries + ' ' + url + ' ' + (e.name || ''));
      if (i === tries) throw e;
      await sleep(600 * i);
      if (jar.size) h.Cookie = ck();
    }
  }
}
async function speedTest(hosts) {
  const out = [];
  for (const h of hosts) {
    const base = /^https?:/.test(h) ? h.replace(/\/+$/, '') + '/' : 'http://' + h + '/';
    let ok = false, err = '', cost = Infinity;
    const t0 = performance.now();
    try {
      const r = await fetch(base + 'loginAction.do', { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(8000) });
      const ab = await r.arrayBuffer();
      if (!r.ok) err = 'HTTP ' + r.status;
      else if (ab.byteLength < 500) err = '内容异常';
      else { ok = true; cost = performance.now() - t0; }
    } catch (e) { err = e.name === 'TimeoutError' ? '超时' : '连不上'; }
    out.push({ base, host: h, ok, best: cost, err });
  }
  out.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.best - b.best));
  S.captured = out.map(r => ({ host: r.host, ok: r.ok, ms: r.ok ? Math.round(r.best) : null, err: r.err }));
  const win = out.find(r => r.ok) || out[0];
  BASE = win.base; S.node = win.host;
  log('节点 ' + win.host + (win.ok ? ' ' + Math.round(win.best) + 'ms' : ' 未测通，兜底使用'));
}
const isLoginPage = t => /name="v_yzm"/.test(t) || /URP综合教务系统 - 登录/.test(t);
const errRowOf = t => { const m = t.match(/class="errorTop"[^>]*>([\s\S]*?)<\/td>/i); return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : ''; };

function waitManualCaptcha(buf) {
  lastCaptchaBuf = buf; S.needCaptcha = true; S.phase = 'need-captcha';
  log('验证码自动识别失败，请到网页上手动输入');
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; S.needCaptcha = false; captchaResolver = null; resolve(v); };
    captchaResolver = finish;
    setTimeout(() => finish(''), 180000);
  });
}
async function getCaptchaCode() {
  const cap = await req('validateCodeAction.do?random=' + Math.random(), { timeoutMs: 25000, tries: 3 });
  const buf = Buffer.from(await cap.arrayBuffer());
  if (ocrReady) {
    try { const t = await recognizeJpeg(buf); if (t && /^[0-9A-Za-z]{3,6}$/.test(t)) return t; }
    catch (e) { log('本地 OCR 异常: ' + (e && e.message)); }
  }
  return await waitManualCaptcha(buf);
}
async function login(cfg) {
  for (let a = 0; a < 6; a++) {
    if (stopFlag) return 'netfail';
    try {
      jar = new Map();
      await req('loginAction.do');
      await sleep(300);
      const code = await getCaptchaCode();
      if (!code) { log('没拿到验证码，重试'); continue; }
      const r = await req('loginAction.do', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + 'loginAction.do' },
        body: new URLSearchParams({ zjh: cfg.user, mm: cfg.pass, v_yzm: code }).toString(),
      });
      const t = dec(await r.arrayBuffer());
      if (/学分制综合教务/.test(t)) { log('登录成功'); S.phase = 'login'; return 'ok'; }
      const e = errRowOf(t);
      if (/您的密码不正确|密码不正确|密码错误|帐号不存在|账号不存在|证件号不存在/.test(e)) { log('密码不正确：' + e); return 'badpass'; }
      log('验证码/网络问题，重试（' + (e || '无提示') + '）');
      await sleep(400);
    } catch (err) { log('登录异常: ' + (err && err.message)); await sleep(1200); }
  }
  return 'netfail';
}
async function selectPlan() {
  const t = dec(await (await req('xkAction.do')).arrayBuffer());
  if (isLoginPage(t)) return false;
  const plans = [];
  for (const m of t.matchAll(/<input[^>]*>/gi)) {
    const tag = m[0];
    if (!/type=["']?radio/i.test(tag) || !/name=["']?fajhh/i.test(tag)) continue;
    const id = (tag.match(/id=["']([^"']+)/i) || [])[1] || '';
    const val = (tag.match(/value=["']([^"']+)/i) || [])[1] || '';
    if (val) plans.push({ id, fajhh: val });
  }
  if (!plans.length) return true;
  await req('xkAction.do?actionType=-1&fajhh=' + plans[0].fajhh + '&xdlxdm=' + plans[0].id);
  log('已选方案 ' + plans[0].fajhh);
  return true;
}
function parseRows(html, page) {
  const out = [];
  for (const tr of (html.match(/<tr[\s\S]*?<\/tr>/gi) || [])) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const kch = cells.find(x => /^\d{8,10}$/.test(x));
    if (!kch) continue;
    const i = cells.indexOf(kch);
    const cb = tr.match(/name=["']kcId["'][^>]*?(?:id|value)=["']([^"']+)/i);
    out.push({ kch, kcm: cells[i + 1] || '', kxh: cells[i + 2] || '', js: cells[i + 6] || '',
      left: parseInt(String(cells[i + 7] || '').replace(/[^\d-]/g, ''), 10),
      group: (cells[i + 10] || '').replace(/^[;；,，\s]+/, ''), kcId: cb ? cb[1] : null, page });
  }
  return out;
}
/** 扫某一个选课分类；返回 { rows, note }（note = 空分类的原因）/ null（会话失效） */
async function scanCat(type) {
  const t1 = dec(await (await req('xkAction.do?actionType=' + type + '&pageNumber=1')).arrayBuffer());
  if (isLoginPage(t1)) return null;
  let rows = parseRows(t1, 1).map(r => ({ ...r, cat: type }));
  const pages = Math.min(Number((t1.match(/共\s*(\d+)\s*页/) || [])[1] || 1), 30);
  for (let p = 2; p <= pages; p++) {
    rows = rows.concat(parseRows(dec(await (await req('xkAction.do?actionType=' + type + '&pageNumber=' + p)).arrayBuffer()), p).map(r => ({ ...r, cat: type })));
  }
  const seen = new Set();
  rows = rows.filter(x => { const k = type + '|' + x.kch + '_' + x.kxh; if (seen.has(k)) return false; seen.add(k); return true; });
  let note = '';
  if (!rows.length) {
    const plain = t1.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const m = plain.match(/(?:提示[:：]?\s*)?([^ ]{0,24}(?:已关|关闭|不允许|暂无|没有[^ ]{0,6})[^ ]{0,8})/);
    note = m ? m[1] : '当前没有课程';
  }
  return { rows, note };
}
async function enrolled() {
  const t = dec(await (await req('xkAction.do?actionType=6')).arrayBuffer());
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
  await req(listUrl);
  let v = { ok: null, txt: '' }, timedOut = false;
  try {
    const r = await req('xkAction.do', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + listUrl },
      body: 'preActionType=' + type + '&actionType=9&kcId=' + encodeURIComponent(c.kcId), timeoutMs: 25000 });
    v = verdict(dec(await r.arrayBuffer()));
  } catch (e) { timedOut = true; log('提交超时: ' + (e && e.message)); await sleep(2000); }
  const list = await enrolled().catch(() => null);
  const got = list ? list.some(x => x && x.kch === c.kch) : false;
  if (timedOut && got) v = { ok: true, txt: '（提交超时，但课表已确认）' };
  return { v, got, list };
}
function notify(title, msg) {
  try {
    const esc = s => String(s).replace(/'/g, "''");
    const ps = "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;" +
      '$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;' +
      "$n.ShowBalloonTip(20000,'" + esc(title) + "','" + esc(msg) + "',[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep -Seconds 20;$n.Dispose()";
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', '[console]::beep(880,180);[console]::beep(1175,180);[console]::beep(1397,260)'], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

/** 一次性扫全部所选分类（给网页「扫一次课」用） */
async function scanForUi(cfg) {
  const types = (cfg.types && cfg.types.length ? cfg.types : [cfg.type || '3']).map(String);
  let all = [];
  for (const t of types) {
    let r = null;
    for (let i = 1; i <= 2 && r === null; i++) {
      try { r = await scanCat(t); } catch (e) { log('扫描异常 ' + (CATNAME[t] || t) + ': ' + (e && e.message)); await sleep(600); }
    }
    if (!r) continue;
    if (!r.rows.length) {
      if (!S.catNotes[t]) { S.catNotes[t] = 1; log((CATNAME[t] || t) + '：' + r.note); }
      continue;
    }
    S.catNotes[t] = 0;
    all = all.concat(r.rows);
  }
  return all.map(r => ({ kch: r.kch, kxh: r.kxh, kcm: r.kcm, js: r.js, group: r.group, left: r.left,
    cat: r.cat, key: r.kch + '_' + r.kxh, can: !!(r.kcId && r.left > 0) }));
}

// ---------------- 引擎 ----------------
async function engine(cfg) {
  S.running = true; S.round = 0; S.startedAt = Date.now(); S.lastError = ''; stopFlag = false;
  const notified = new Set();
  let emptyStreak = 0;
  try {
    S.phase = 'starting';
    await speedTest(cfg.hosts);
    for (let n = 1; !stopFlag; n++) {
      S.phase = 'login';
      const st = await login(cfg).catch(() => 'netfail');
      if (st === 'ok') break;
      if (st === 'badpass') { S.phase = 'error'; S.lastError = '密码不正确，请改好密码再开始'; return; }
      log('登录未成功（第 ' + n + ' 次），稍后继续');
      await sleep(Math.min(30000, 5000 * n));
    }
    for (let i = 0; i < 3; i++) { try { if (await selectPlan()) break; } catch (e) { log('选方案异常: ' + (e && e.message)); await sleep(1000); } }
    S.phase = 'watching';
    const wantG = (cfg.group || '').trim(), wantT = (cfg.teacher || '').trim();
    const byFilter = (wantG || wantT) && !(cfg.candidates || []).length;
    while (!stopFlag) {
      S.round++;
      const types = (cfg.types && cfg.types.length ? cfg.types : [cfg.type || '3']).map(String);
      let rows = null, anyOk = false;
      for (const t of types) {
        let r = null;
        for (let i = 1; i <= 3 && r === null; i++) {
          try { r = await scanCat(t); } catch (e) { log('扫描异常 ' + (CATNAME[t] || t) + ' ' + i + '/3: ' + (e && e.message)); await sleep(700 * i); }
        }
        if (r === null) continue;
        anyOk = true;
        if (!r.rows.length) {
          if (!S.catNotes[t]) { S.catNotes[t] = 1; log((CATNAME[t] || t) + '：' + r.note); }
          continue;
        }
        S.catNotes[t] = 0;
        rows = (rows || []).concat(r.rows);
      }
      if (!anyOk) {
        S.phase = 'login';
        const st = await login(cfg).catch(() => 'netfail');
        if (st === 'badpass') { S.phase = 'error'; S.lastError = '密码不正确'; return; }
        if (st === 'ok') { try { await selectPlan(); } catch {} }
        await sleep(5000); continue;
      }
      if (!rows || !rows.length) {
        emptyStreak++; S.phase = 'waiting'; S.rows = []; S.matched = [];
        if (emptyStreak === 1 || emptyStreak % 10 === 0) log('列表为空（第 ' + emptyStreak + ' 轮）：选课可能还没开放，继续等');
      } else {
        if (emptyStreak) log('列表有数据了（之前空了 ' + emptyStreak + ' 轮）');
        emptyStreak = 0; S.phase = 'watching';
        if (byFilter && !rows.filter(r => (!wantG || (r.group || '').includes(wantG)) && (!wantT || (r.js || '').includes(wantT))).length
            && (S.round <= 1 || S.round % 10 === 0)) {
          log('⚠️ 筛选没匹配到任何课程（老师="' + wantT + '" 类别="' + wantG + '"），请检查是否写错');
        }
        S.rows = rows.map(r => ({ kch: r.kch, kxh: r.kxh, kcm: r.kcm, js: r.js, group: r.group, left: r.left, cat: r.cat, can: !!(r.kcId && r.left > 0) }));
        let hits = [];
        if (byFilter) hits = rows.filter(r => (!wantG || (r.group || '').includes(wantG)) && (!wantT || (r.js || '').includes(wantT)));
        else for (const q of (cfg.candidates || [])) {
          const s = String(q).trim();
          if (/^\d{8,10}_\d+$/.test(s)) hits = hits.concat(rows.filter(r => r.kch + '_' + r.kxh === s));
          else hits = hits.concat(rows.filter(r => r.kch === s || (r.kcm && r.kcm.includes(s))));
        }
        S.matched = hits.map(r => ({ kch: r.kch, kxh: r.kxh, kcm: r.kcm, js: r.js, group: r.group, left: r.left, cat: r.cat, can: !!(r.kcId && r.left > 0) }));
        let avail = hits.filter(r => r.kcId && r.left > 0);
        // 测试钩子：XK_FORCE_SUBMIT=1 时强行拿一门满课去提交（服务端必然拒绝，不改变状态）
        if (!avail.length && process.env.XK_FORCE_SUBMIT && hits.length) {
          const t = hits[0];
          avail = [{ ...t, kcId: t.kcId || (t.kch + '_' + t.kxh) }];
          log('【测试】强制提交满课 ' + t.kch + '_' + t.kxh + '（预期被拒绝）');
        }
        if (avail.length) {
          const x = avail[0], key = x.kch + '_' + x.kxh;
          if (!notified.has(key)) {
            notified.add(key);
            log('发现余量 ' + key + ' ' + x.kcm + ' 余量=' + x.left + (x.group ? ' [' + x.group + ']' : '') + (x.cat ? ' ' + (CATNAME[x.cat] || '') : ''));
            notify('余量出现！', (x.group ? x.group + ' · ' : '') + x.kcm + ' 余量 ' + x.left);
          }
          if (cfg.mode === 'auto') {
            S.phase = 'submitting';
            log('自动抢：提交 ' + key);
            const { v, got, list } = await submit(x, x.cat || cfg.type);
            log('教务回复：' + (v.txt || '(未识别)') + ' | 课表 ' + (list ? list.length : '?') + ' 门');
            if (got || v.ok) {
              S.phase = 'grabbed';
              log('抢课成功 ' + x.kch + ' ' + x.kcm);
              notify('抢课成功', x.kcm + ' 已选上，请尽快去教务确认');
              return;
            }
            S.phase = 'watching';
          }
        }
      }
      const slow = emptyStreak > 0 ? Math.min(20, 1 + Math.floor(emptyStreak / 3)) : 1;
      const wait = Math.min(60000, Math.max(MIN_INTERVAL, Number(cfg.interval) || 3) * 1000 * slow);
      const until = Date.now() + wait;
      while (Date.now() < until && !stopFlag) await sleep(300);
    }
  } catch (e) {
    S.phase = 'error'; S.lastError = (e && e.message) || String(e); log('引擎异常: ' + S.lastError);
  } finally {
    if (S.phase !== 'grabbed' && S.phase !== 'error') S.phase = 'idle';
    S.running = false;
  }
}

// ---------------- HTTP ----------------
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};
const readBody = req_ => new Promise(r => { let b = ''; req_.on('data', c => b += c); req_.on('end', () => r(b)); });

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (url === '/' || url === '/index.html') {
      const html = fs.readFileSync(PAGEF);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length,
        'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache', Expires: '0' });
      return res.end(html);
    }
    if (url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url === '/api/state') {
      return json(res, 200, {
        running: S.running, phase: S.phase, round: S.round, startedAt: S.startedAt, node: S.node,
        lastError: S.lastError, rows: S.rows, matched: S.matched, logs: S.logs.slice(-120),
        captured: S.captured, needCaptcha: S.needCaptcha, scanRows: S.scanRows,
        cfg: { ...S.cfg, pass: S.cfg.pass ? '******' : '' },
      });
    }
    if (url === '/api/captcha' && req.method === 'GET') {
      if (!lastCaptchaBuf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': lastCaptchaBuf.length });
      return res.end(lastCaptchaBuf);
    }
    if (url === '/api/captcha' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (captchaResolver) captchaResolver(String(b.code || '').trim());
      return json(res, 200, { ok: true });
    }
    if (url === '/api/scan' && req.method === 'POST') {
      if (S.running) return json(res, 400, { ok: false, error: '正在盯课，先点「停止」' });
      if (S.scanning) return json(res, 409, { ok: false, error: '正在扫课，稍等一下' });
      S.scanning = true;
      req.on('close', () => {});
      if (!S.cfg.user || !S.cfg.pass) return json(res, 400, { ok: false, error: '先填学号和密码' });
      S.needCaptcha = false;
      log('手动扫课…');
      try { await speedTest(S.cfg.hosts); } catch {}
      let st = await login(S.cfg).catch(() => 'netfail');
      if (st === 'badpass') return json(res, 400, { ok: false, error: '密码不正确' });
      if (st !== 'ok') return json(res, 500, { ok: false, error: '登录没成功（网络问题），稍后再试' });
      try { await selectPlan(); } catch {}
      try {
        const rows = await scanForUi(S.cfg);
        S.scanRows = rows;
        S.node = S.node || '';
        log('扫课完成：' + rows.length + ' 门，其中可选 ' + rows.filter(r => r.can).length + ' 门');
        return json(res, 200, { ok: true, rows, count: rows.length, canCount: rows.filter(r => r.can).length });
      } catch (e) {
        log('扫课失败: ' + (e && e.message));
        return json(res, 500, { ok: false, error: String((e && e.message) || e) });
      } finally {
        S.scanning = false;
      }
    }
    if (url === '/api/config' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.user) return json(res, 400, { ok: false, error: '学号不能为空' });
      const next = { ...S.cfg, ...b, interval: Math.max(MIN_INTERVAL, Number(b.interval) || 3) };
      if (!b.pass || b.pass === '******') next.pass = S.cfg.pass;
      if (!next.pass) return json(res, 400, { ok: false, error: '密码不能为空' });
      S.cfg = next; saveCfg(next);
      return json(res, 200, { ok: true });
    }
    if (url === '/api/start' && req.method === 'POST') {
      if (S.running) return json(res, 200, { ok: true });
      if (!S.cfg.user || !S.cfg.pass) return json(res, 400, { ok: false, error: '先填学号和密码' });
      stopFlag = false;
      engine({ ...S.cfg }).catch(e => { S.phase = 'error'; S.lastError = String((e && e.message) || e); S.running = false; });
      return json(res, 200, { ok: true });
    }
    if (url === '/api/stop' && req.method === 'POST') {
      stopFlag = true;
      if (captchaResolver) captchaResolver('');
      log('已请求停止');
      return json(res, 200, { ok: true });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

(async () => {
  const md = path.join(DIR, 'model');
  try { ocrReady = await initOcr(path.join(md, 'common_old.onnx'), path.join(md, 'charset.json'), path.join(md, 'ort')); } catch {}
  S.cfg = loadCfg();
  const port = Number(process.env.PORT || 0);
  server.listen(port, '127.0.0.1', () => {
    const p = server.address().port;
    const url = 'http://127.0.0.1:' + p + '/';
    console.log('');
    console.log('  教务抢课助手 · 本地网页版');
    console.log('  ' + url);
    console.log('  验证码识别: ' + (ocrReady ? '本地模型' : '网页手输'));
    console.log('  这个窗口别关（关了服务就停），可以最小化');
    console.log('');
    log('服务启动 ' + url);
    if (!process.env.NO_OPEN) { try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); } catch {} }
  });
})();
