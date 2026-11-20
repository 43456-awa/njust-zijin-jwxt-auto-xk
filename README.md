# 南理工紫金学院教务系统自动抢课

针对 **URP 综合教务系统**（正方/强智系 URP，`*.do` 那一套）的选课助手。三种形态：

| 形态 | 入口 | 适合 |
|---|---|---|
| 命令行 | `node xk.mjs ...` | 想自己控制、看日志、写脚本 |
| 交互向导 | `node xkg.mjs` | 双击就跑，问几个问题然后挂着 |
| 本地网页 | `node xkw.mjs` | 浏览器里点按钮，看余量表格 |

接口细节全部来自实测，记录在 [docs/FINDINGS.md](docs/FINDINGS.md)：登录链路、选课分类的 `actionType`、提交选课的三个必备条件（`Origin` 头 / 先 GET 对齐页码 / `pageNumber=-1` 是最后一页的陷阱）。

---

## ⚠️ 先读免责声明

- **只用于你自己的账号**。不要把别人的学号密码填进来，也不要代理别人抢课。
- 自动化选课**通常违反学校教务管理规定**，可能被**取消选课结果**或按校纪处理。用之前先确认你校的规定，风险自负。
- 本项目**默认限速**：轮询间隔最小 3 秒、带随机抖动、有轮数上限，**不做并发轰炸**。请不要把间隔改到 1 秒以下——那既容易被封，也会拖垮学校服务器。
- 代码按“现状”提供，不保证对你的教务系统版本有效；接口改版后自行修。
- 仅供学习网络请求、表单流程与 ONNX 验证码识别之用。

## 环境

- Node.js **18 或更新**（用到内置 `fetch` 和 `getSetCookie`）
- 能访问学校教务系统（校内网 / 校园网 / 或学校允许的 VPN）
- 首次运行需要 `npm install`（装 `onnxruntime-web` 和 `jpeg-js`，用来本地识别验证码）

```bash
npm install
```

## 配置教务地址

默认地址已经内置（校内教务 URP，三个节点）：
`http://192.168.16.207` / `192.168.16.208` / `192.168.16.209`
在校内网 / 校园网下直连即可，不需要 VPN。地址变了就用环境变量或参数覆盖：

```bash
export URP_USER=你的学号
export URP_PASS=你的教务密码
export URP_BASE=http://192.168.16.207     # 需要时覆盖

# 或命令行参数
node xk.mjs grab --course 现代科技1 --base http://192.168.16.207 --live
```

> 三个节点**共享同一账号状态**（实测同时登录会互踢），用 `--hosts a,b,c` 或 `--auto-host` 先测速再选；**绝不要并发登录**。

## 用法

### 1) 命令行：先侦察，再抢

```bash
node xk.mjs login                       # 登录 + 列出「选课」相关入口
node xk.mjs menu                        # 复用会话列菜单
node xk.mjs dump /xkAction.do           # 抓页面（GBK→UTF8），列出表单字段
node xk.mjs speed                       # 多节点测速（只 GET 登录页，不登录）
node xk.mjs grab --course 现代科技1 --live
```

`post` / `grab` **默认 dry-run**：只打印将要发送的请求，不真的提交；加 `--live` 才提交。

多候选按优先级递补，第一个有课余量的就抢：

```bash
node xk.mjs grab --course 99001731 --course 名画中的瘟疫史 --course 现代科技 --live
```

### 2) 交互向导

```bash
node xkg.mjs
```

首次运行问：学号 → 密码 → 抢哪些课（课程号或课名，最多 5 个，按优先级）→ 轮询间隔 → 模式（`watch` 只提醒 / `auto` 自动抢）。
密码默认不落盘，可选记住（写在本机 `config.json`）。选课没开放时会一直等，不退出。

### 3) 本地网页

```bash
node xkw.mjs      # 只监听 127.0.0.1，自动开浏览器
```

网页里填学号密码、候选课，勾选后开始轮询；余量表会标出哪些课“有余量且可勾”。

## 抢课判据（实测）

能不能抢，看两条，缺一不可：

1. **课余量 > 0**
2. **该行存在 `<input type="checkbox" name="kcId" value="课程号_课序号">`** —— 余量为 0 或受限的课，页面里根本不渲染勾选框

提交成功/失败是**返回页正文**里的文字：`选课成功！` / `你选择的课程<课名>[<序号>]没有课余量`。脚本用双通道判定，并回查 `actionType=6` 的已选清单做二次确认。

## 目录

```
xk.mjs              命令行主程序（login/menu/dump/post/grab/speed）
xkg.mjs             交互向导（同学版）
xkw.mjs             本地网页版后端（只监听 127.0.0.1）
ocr.mjs             验证码识别（ONNX + 与 ddddocr 一致的预处理/CTC 解码）
page.html           网页版前端
config.example.json 配置模板
model/common_old.onnx  验证码模型（ddddocr 的 common_old）
model/charset.json     字符集
model/ort/          onnxruntime-web 的 wasm 运行时
docs/FINDINGS.md    接口实测记录（最值钱的一页）
docs/使用说明.md      向导版的傻瓜说明
```

## 验证码

登录验证码是 4 位数字字母，用 ddddocr 的 `common_old.onnx` 本地识别（onnxruntime-web wasm），单次 15–40ms，实测与服务器端 ddddocr 结果 9–10/10 一致。
预处理必须严格对齐：高 64、宽 `int(w*64/h)`、LANCZOS 缩放、PIL 定点灰度公式、NCHW 单通道；输出是 `[T,1,C]`，CTC 解码跳过重复与 blank。细节见 FINDINGS.md。

识别不出来时脚本会退回**人工输入验证码**，不会卡死。

## 致谢

- [ddddocr](https://github.com/sml2h3/ddddocr) —— 验证码模型的来源（MIT）
- [onnxruntime-web](https://github.com/microsoft/onnxruntime) —— 浏览器/wasm 推理
- [jpeg-js](https://github.com/jpeg-js/jpeg-js) —— 纯 JS JPEG 解码

## License

MIT，见 [LICENSE](LICENSE)。
