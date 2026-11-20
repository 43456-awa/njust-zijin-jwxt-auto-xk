# URP 选课接口实测记录（2026-10-21）

账号：你的学号（示例；方案号因人而异）
入口：`http://192.168.16.207/`（本机在内网，直连即可，无需 VPN）

## 登录

| 步骤 | 请求 |
|---|---|
| 1 | `GET loginAction.do` （拿 JSESSIONID） |
| 2 | `GET validateCodeAction.do?random=<rand>` （验证码 JPEG） |
| 3 | OCR（ddddocr，POST 图片到 `127.0.0.1:5003/ocr`） |
| 4 | `POST loginAction.do` body: `zjh=学号&mm=密码&v_yzm=验证码` |

成功返回 491 字节 frameset（含 `/menu/top.jsp` + `/menu/mainFrame.jsp`）。
失败返回登录页，正文含「账号或密码错误」。

## 菜单（frameset 结构）

- `/menu/top.jsp` → UTF-8，7 个模块：007 我的需留意 / 008 个人管理 / **009 选课管理** / 010 教学评估 / 011 考务管理 / 012 教学资源 / 013 综合查询
- `/menu/menu.jsp?code=009` → GBK，左侧菜单项（含 URL）

### 选课管理（009）全部入口

| 功能 | 接口 |
|---|---|
| 选课公告 | `/ckgg.jsp?type=1` |
| **网上选课** | `/xkAction.do` （先出「选方案」页） |
| 选课结果 / 本学期课表 | `/xkAction.do?actionType=6` |
| 退课 | `/xkAction.do?actionType=7` |
| 无效选课结果 | `/xkAction.do?actionType=16` |
| 实验课选课 | `/syglSyxkAction.do?ejkch=&oper=goTosykcList` |

### 选课流程（关键三步）

1. **选方案**：`GET /xkAction.do` 返回「请选择方案名称」，表单只有 radio `fajhh`（本例方案 4951，id=00001）。
   点"网上选课"实际跳：`GET /xkAction.do?actionType=-1&fajhh=4951&xdlxdm=00001`
2. **课程分类**（从该页链接取）：
   | 类别 | actionType |
   |---|---|
   | 计划课程 | 1 |
   | 方案课程 | 2 （`&pageNumber=-1&oper1=ori`） |
   | **校任选课** | **3** （`&pageNumber=-1`） |
   | 系任选课 | 4 |
   | 自由选择 | 5 （`&cx=ori`） |
   | 重修课程 | 14 |
3. **提交选课**（从课程表格末尾的隐藏字段读出）：
   ```
   POST /xkAction.do
   Content-Type: application/x-www-form-urlencoded
   Referer: http://192.168.16.207/xkAction.do

   preActionType=3&actionType=9&kcId=<课程号>_<课序号>
   ```
   - `preActionType` = 你所在列表页的 actionType
   - `actionType=9` = 提交选课
   - `kcId` = 勾选框 value（`99000301_01`），可多个

## 课程列表页的字段（校任选课为例）

表头：`选择 | 选课课组 | 课程号 | 课程名 | 课序号 | 学分 | 课程属性 | 考试类型 | 教师 | 课余量`

**判断"能不能抢"的两条依据**：
1. **课余量 > 0**（最后一列）
2. **该行存在 `<input type="checkbox" name="kcId" value="课程号_课序号">`**
   —— 余量为 0 或受限的课**根本没有勾选框**（实测：音乐鉴赏1 余量 0 时无框，余量变 1 后出现）

## 未验证的部分（诚实标注）

- `actionType=9` 是**从页面隐藏字段读出来的**，我**没有真的提交过**（按用户要求全程 dry-run）。
  第一次 `--live` 建议选一门本来就想上的课，成功后脚本会自动复核 `actionType=6` 课表。
- 退课提交的 action code 未确认（`actionType=7` 是退课**列表页**）。
- 选课是否有"每人限选门数/学分上限/时间冲突"的校验，只能在真实提交时才知道。
## 分页陷阱（实测，2026-10-21）

| pageNumber | 实际返回 |
|---|---|
| **-1** | **最后一页**（不是第 1 页！） |
| 1 | 第 1 页（50 门） |
| 2 | 第 2 页（13 门） |
| 3（越界） | 退化成最后一页 |

→ 抢课必须 **从 pageNumber=1 顺序扫到"共 N 页"**，否则会漏课。
（实测：名画中的瘟疫史 `99035311_01` 就在第 2 页。）

## 提交结果的形式（用户确认）

**成功和失败都是浏览器 `alert()` 弹窗**：
- 成功：「选课成功」
- 失败：「课余量已满，选课失败」
- **无需再次输入验证码**，**没有二次校验**

→ 脚本用 `alert(...)` 文本判定成败，再用「已选课程清单」复核（双保险）。

## 可靠的"已选课程清单"

`GET xkAction.do?actionType=6` 页面里除周网格外，还有一张**明细表**：
`培养方案 | 课程号 | 课程名 | 课序号 | 学分 | 属性 | 考试类型 | 教师`
实测 7 行（示例：若干门专业必修课）。

⚠️ 不要用周网格判断 —— **慕课没有固定时间地点，不在网格里**。

## 选课公告

`ckgg.jsp?type=1` → **"暂时没公告"**（253 字节）。规则信息目前不可得。

## 名画中的瘟疫史（用户关注）

| 字段 | 值 |
|---|---|
| 课程号_课序号 | `99035311_01` |
| 课程名 | 名画中的瘟疫史 |
| 教师 | 紫金慕课* |
| 栏目/页码 | 校任选课（actionType=3）第 **2** 页 |
| 余量 | **0** → 无勾选框，当前不可选 |
| 状态列 | 可选可退 |

附：全部 11 门紫金慕课（视觉与艺术/书法创作与欣赏/生活中的趣味物理/创意摄影/运动安全与健康/实验室安全与防护/大学生国家安全教育/安全用电/名画中的瘟疫史/网络安全与管理/人工智能引论）**余量全部为 0**。
---

# ★ 提交环节已实测打通（2026-10-21 下午）

## 真实提交请求（浏览器抓包 + 直连复现双重验证）

```
POST http://192.168.16.207/xkAction.do
Content-Type: application/x-www-form-urlencoded
Origin: http://192.168.16.207                      ← ★必须带！否则 500 或被静默忽略
Referer: http://192.168.16.207/xkAction.do?actionType=3&pageNumber=-1
Cookie: JSESSIONID=...; route=...

kcId=99033611_01&preActionType=3&actionType=9
```

## 三个坑（都是实测踩出来的）

1. **必须带 `Origin` 头** —— 不带时：无会话上下文 → `500 Servlet Exception in '/WEB-INF/JSP/xk/xkFormLayou...'`；有上下文 → 静默重渲染列表、不处理。
2. **必须先用 GET 把会话带到对应的列表页**（如 `actionType=3&pageNumber=1`），否则同样 500。
3. **`pageNumber=-1` 是"最后一页"**，要从 `pageNumber=1` 顺序扫。

## 失败提示：是**页面正文**，不是 alert

满课提交（99033611_01「中国历史地理」，余量 0）返回：

```
http=200  len=76095  title=校任选课开课信息
正文：「你选择的课程中国历史地理[01]没有课余量」
已选课程：7 门 → 7 门（状态未被改变 ✅）
```

→ 脚本判定改为**双通道**：先扫 `alert(...)`，再扫正文关键词（你选择的课程… / 没有课余量 / 选课成功 / 冲突 / 已选 / 超过）。

## 页面架构（两窗格）

外层 `xkAction.do?actionType=-1&fajhh=4951&xdlxdm=00001`：
- 上 iframe `inforUpContent` = 课程列表（默认「方案课程」actionType=2）
- 下 iframe `inforDownContent` = 已选课程（actionType=6）
- 外层「确定」按钮 = `inforUpContent.xkActionForm.submit()`（提交列表页那个 form）
- 图标的 onclick 里还有：`window.open('xkAction.do?actionType=6|7|16')`

## 仍未验证

- **成功话术**：需要一次真实的成功选课才知道（失败话术已知）。
- 退课提交的 action code（`actionType=7` 只是退课列表页）。
- 余量是否实时（缓存问题）。
- 限选门数 / 学分上限 / 时间冲突是否真无校验。

## 安全性记录

所有试探（满课提交 / 假课程号 / 重复提交 / 浏览器拦截）**均未改变账号状态**：7 门课自始至终未变。
---

# ★★ 完整闭环已跑通（2026-10-21 14:09 真实选课成功）

## 成功案例：真实选中 99001731「现代科技1」

```
node xk.mjs grab --course 99001731 --type 3 --live
```

输出：
```
 （共 2 页，扫到 63 门课）
 [1 14:09:36] 99001731_01 现代科技1 | 李雷* | 余量=111 | ✅ 可选
 ⚡ 提交中…（先把会话对齐到该课所在第 1 页）
   教务回复: 选课成功！
   复核已选清单: ✅ 已存在（共 8 门）
 🎉 抢课成功：99001731 现代科技1
```

独立复核：已选课程 7 门 → **8 门**，新增 `99001731 | 现代科技1 | 01 | 1.0 | 任选 | 考查 | 李雷*` ✓

## 成功 / 失败话术（都已实测）

| 场景 | 返回 |
|---|---|
| **成功** | 正文含 **「选课成功！」** |
| **失败（满课）** | 正文含「你选择的课程<课程名>[<课序号>]没有课余量」 |

两者都**不是** alert 弹窗，是返回页正文；页内那个「请输入要跳转的页面！」是分页函数里写死的静态提示，属噪声，脚本已过滤。

## 提交成功的完整条件（缺一不可）

1. `Origin: http://192.168.16.207`
2. `Referer` 必须**带上该课所在页**：`.../xkAction.do?actionType=3&pageNumber=<该课所在页>`
3. 提交前**先 GET 那个列表页**，让服务端"当前页"= 该课所在页（否则静默重渲染、不处理）
4. body：`kcId=<课程号>_<课序号>&preActionType=<类别>&actionType=9`

## 仍未知

- **退课提交的 action code**（`actionType=7` 只是退课列表页）
- 余量是否实时（本次 152→111 是别人在抢，说明大致实时）
- 限选门数/学分上限是否存在
---

# 多节点与多候选（2026-10-21）

## 三个教务 IP（实测均可登录）

| IP | 测速（最快/平均） |
|---|---|
| 192.168.16.209 | 20ms / 27ms |
| 192.168.16.208 | 33ms / 35ms（另一次 23/28） |
| 192.168.16.207 | 31–41ms / 43–59ms |

- 三个节点**共享同一账号状态**（用户确认：同时登录会互踢）→ **绝不能并发登录**。
- 测速**只用 GET 登录页、不登录**，因此对会话零影响；顺序执行，不并发。
- 换节点后旧 cookie 作废 → 脚本自动清空 jar 并重新登录。

## 多候选递补

`node xk.mjs grab --course A --course B --course C` —— 每轮扫描后按优先级依次判断：
第一个"余量>0 且有勾选框"的就提交；都满则睡一个间隔后重扫。

实测（dry-run）：
```
候选1/3 99033611_01 中国历史地理 | 余量=0 | ❌ 已满
候选2/3 99001731_01 现代科技1 | 余量=108 | ✅ 可选   ← 自动递补
```
---

# 验证码 OCR 本地移植（2026-10-21）

## 结论

把服务器的 ddddocr 完整移植到本地 JS（onnxruntime-web wasm + jpeg-js），**与服务器识别结果 9–10/10 完全一致**，单次识别约 15–40ms。

## 踩到的坑（按重要性）

1. **模型不是 common.onnx！** `load_ocr_model(old=False, beta=False)` 实际加载的是 **`common_old.onnx`（13.6MB）**；
   `common.onnx`（54MB）只有在 `beta=True` 时才用。用错模型 → 输出差 25 以上、识别成全汉字。
2. 预处理必须严格对齐：
   - `target_height=64`，`target_width=int(w*64/h)`（**int 截断**）
   - resize 用 **LANCZOS**（不是双线性，否则临界字会大小写翻转）
   - 灰度用 PIL 定点公式 `(r*19595+g*38470+b*7471+0x8000)>>16`
   - `/255`，形状 `[1,1,64,W]`（NCHW，单通道）
3. 输出形状是 **`[T,1,8210]`**（不是 `[1,T,C]`）→ 取 `dims[0]` 为 T、`dims[-1]` 为类别数。
4. CTC 解码：每步 argmax → **跳过连续重复** → **跳过索引 0（blank）** → 用 `charset_manager.get_charset()` 映射。
5. **验证码不区分大小写**（实测：把识别结果整体翻转大小写仍能登录成功）→ 大小写翻转无害。
6. JS 端：`onnxruntime-web` 需要同目录的 `ort-wasm-simd-threaded.mjs` **和** `.wasm`，
   且 `ort.env.wasm.wasmPaths` 必须是**绝对 file:// URL**（如 `pathToFileURL(dir + path.sep).href`），否则 import 失败。
7. 会话级 `logSeverityLevel: 4` 才能压掉 `VerifyOutputSizes` 那条告警。

## 文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `model/common_old.onnx` | 13.0 MB | ddddocr 默认模型 |
| `model/charset.json` | 57 KB | 8210 字符集（按模型类别顺序） |
| `model/ort/ort-wasm-simd-threaded.wasm` | 13.6 MB | ORT wasm |
| `model/ort/ort-wasm-simd-threaded.mjs` | — | ORT 胶水模块 |
| `ocr.mjs` | — | 预处理 + 推理 + CTC 解码 |

注：`common.onnx`（54MB，beta 模型）已验证不需要，已从分发包剔除。
