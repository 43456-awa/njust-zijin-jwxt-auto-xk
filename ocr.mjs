// 本地验证码识别：移植自 ddddocr（ONNX 模型 + 同样的预处理）
import * as ort from 'onnxruntime-web';
import jpeg from 'jpeg-js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

ort.env.wasm.numThreads = 1;      // Node/编译版里不用 worker
ort.env.wasm.simd = true;
ort.env.logLevel = 'error';       // 屏蔽 ONNX 的 VerifyOutputSizes 之类告警

let session = null;
let charset = null;

export async function initOcr(modelPath, charsetPath, wasmDir) {
  if (session) return true;
  if (wasmDir) {
    // 必须是绝对 file:// URL，ORT 会用 import() 加载同目录的 ort-wasm-*.mjs
    ort.env.wasm.wasmPaths = pathToFileURL(path.resolve(wasmDir) + path.sep).href;
  }
  if (!fs.existsSync(modelPath) || !fs.existsSync(charsetPath)) return false;
  charset = JSON.parse(fs.readFileSync(charsetPath, 'utf8'));
  session = await ort.InferenceSession.create(fs.readFileSync(modelPath), {
    executionProviders: ['wasm'],
    logSeverityLevel: 4,          // 4=fatal，屏蔽 VerifyOutputSizes 等告警
    graphOptimizationLevel: 'all',
  });
  return true;
}

/** 灰度化：与 PIL convert('L') 相同的定点的 ITU-R 601-2 权重 */
function toGray(img) {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(w * h);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = ((data[p] * 19595 + data[p + 1] * 38470 + data[p + 2] * 7471 + 0x8000) >> 16);
  }
  return { w, h, g: out };
}

/** Lanczos-3 权重 */
function lanczos3(x) {
  const a = 3;
  if (x === 0) return 1;
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  const px = Math.PI * x;
  return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}
/** 可分离 Lanczos-3 缩放（对齐 PIL Image.LANCZOS） */
function resizeGray({ w, h, g }, nw, nh) {
  const support = 3;
  // 水平
  const tmp = new Float32Array(nw * h);
  const xscale = w / nw;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      const center = (x + 0.5) * xscale - 0.5;
      const l = Math.max(0, Math.floor(center - support + 1));
      const r = Math.min(w - 1, Math.ceil(center + support - 1));
      let sum = 0, wsum = 0;
      for (let i = l; i <= r; i++) {
        const wt = lanczos3(i - center);
        sum += g[y * w + i] * wt; wsum += wt;
      }
      tmp[y * nw + x] = wsum ? sum / wsum : 0;
    }
  }
  // 垂直
  const out = new Float32Array(nw * nh);
  const yscale = h / nh;
  for (let y = 0; y < nh; y++) {
    const center = (y + 0.5) * yscale - 0.5;
    const l = Math.max(0, Math.floor(center - support + 1));
    const r = Math.min(h - 1, Math.ceil(center + support - 1));
    for (let x = 0; x < nw; x++) {
      let sum = 0, wsum = 0;
      for (let i = l; i <= r; i++) {
        const wt = lanczos3(i - center);
        sum += tmp[i * nw + x] * wt; wsum += wt;
      }
      let v = wsum ? sum / wsum : 0;
      out[y * nw + x] = v < 0 ? 0 : v > 255 ? 255 : v;   // PIL 输出 uint8，需截断
    }
  }
  return out;
}

/** 识别 JPEG 验证码，返回字符串 */
export async function recognizeJpeg(bytes) {
  if (!session) throw new Error('OCR 未初始化');
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  const gray = toGray(img);
  const th = 64;
  const tw = Math.max(1, Math.trunc(img.width * (th / img.height)));   // 与 ddddocr 一致：int()
  const px = resizeGray(gray, tw, th);
  const data = new Float32Array(px.length);
  for (let i = 0; i < px.length; i++) data[i] = px[i] / 255.0;

  const feeds = { input1: new ort.Tensor('float32', data, [1, 1, th, tw]) };
  const out = await session.run(feeds);
  const t = out[Object.keys(out)[0]];
  const dims = t.dims;                      // 实测 [T, 1, C]
  const C = dims[dims.length - 1];          // 类别数（= 字符集长度）
  const T = dims[0];                        // 时间步
  const v = t.data;
  let res = '';
  let prev = -1;
  for (let i = 0; i < T; i++) {
    let best = 0, bestV = -Infinity;
    const base = i * C;
    for (let c = 0; c < C; c++) {
      const val = v[base + c];
      if (val > bestV) { bestV = val; best = c; }
    }
    if (best !== 0 && best !== prev) res += (charset[best] || '');
    prev = best;
  }
  return res;
}
