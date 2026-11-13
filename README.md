# dsh-plugin-class-notes · 听课笔记

给 DSH 加一个「听课笔记」面板：放一份 PPT（或 PDF，会自动转成 PPT），识别每页的关键词，
然后开录音。讲课内容会被切段，按关键词判断老师讲到了哪一页，自动翻页，把每段话写进对应页的
「备注」（speaker notes）。最后导出一份带备注的 .pptx 和一份 .md。

## 装在哪

插件源码在工作区 `dsh-plugin-class-notes/`，通过 junction 挂在
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-class-notes`，
并写进了该 profile `package.json` 的 `dsh.profile.bundles`。

改完代码要让宿主半重新加载：设置 → 插件里把 `class-notes` 关一次再开，
或者重启 DSH。浏览器半改完要刷新页面。

## 怎么用

1. 侧栏点「听课笔记」，右边列表里点「新建」，起个名字（课程可选）。
2. ① 放课件：点一下选 `.pptx` 或 `.pdf`，也可以拖进来，或者粘本机绝对路径导入。
   PDF 会先被转成 PPT（见下一节），转完和直接放 PPT 没区别。
3. ② 认出每页的关键词：先给一版启发式的，按一下按钮用当前默认模型重识别一遍
   （每页 4–8 个能当听写锚点的词，泛词会被剔掉）。
4. ③ 开始记：允许麦克风，每 5 秒一片送去本机 SenseVoice 识别。面板上能看到
   当前页、这一片命中了哪页的关键词、翻页判据，以及最近几片的话。
   讲错了可以手动「上一页 / 下一页」，也可以直接点某一页跳过去。
   录音框里还有「听写」三档：中文 / 中英混合 / English，见下一节。
5. ④ 导出：写 <标题>-听课笔记.pptx（备注里是【听课笔记 · 录音整理】那一段）
   和 <标题>-听课笔记.md。老师原有的备注不会被覆盖，同一个文件反复导出也不会重复堆。
6. ⑤ AI 纪要：按一下「总结这节课」，当前默认模型把这节课听到的内容整理成一份纪要
   （见下面「AI 纪要」一节）。

## 一节 = 一份课件

一节课就是一份课件，从放进去到「结束转录」为止：

- **停止**只是把麦克风放下，这节还开着，随时能再点开始接着记；
- **结束转录**（③里、停止旁边那个）才把这节封掉：状态变成已结束，`finishedAt` 记上时间，
  之后这一节不再接收录音（再送片段会被 409 挡回来），备注就定稿了，可以导出；
- 对一节已经结束的课**再传课件**（点选、拖进来、本机路径都一样），不会覆盖旧记录，
  而是自动开一节新的：标题取课件文件名，课程和听写模式跟着上一节走，然后接着记下一份课件。

面板上：已结束的课在 ③ 里显示「这节课已结束」，旁边有「开下一节」；左侧列表里带「完成」。
所以连着上两节课的操作就是：放课件 → 讲 → 结束转录 → 放下一份课件（自动开新的）。

## 每个课件都是一节独立的课，进度不会串

一节课 = 一份课件 = 一个会话（`~/.dsh/storages/class-notes/<id>/`）。面板上每一处进度
都只属于当前这一节：

- 忙碌状态带上了会话 id（`busy: {id, kind}`）：A 在转 PDF / 认关键词 / 补中文说法 /
  写纪要 / 导出时切到 B，B 的按钮上是干净的，不会显示「正在整理…」这类属于 A 的转圈。
- 导出结果同理（`exportResult.id`）：B 的 ④ 不会出现 A 的下载链接。
- 切课的那一瞬间旧数字就消失：`loadSession` 先把 `session` 置空（面板显示「正在打开
  这节课…」），再用序号 `loadSeq` 丢弃迟到的响应，所以慢网络下也不会把上一节的内容
  画到新一节的标题下面。
- 录音引擎、听写模式、导出、纪要全部按会话落盘，宿主半的每个路由第一句都是
  `requireSession`，不存在「当前会话」这种全局状态。

## 录音只属于一节，不会串

麦克风是唯一的，笔记必须留在自己那节课里，所以两头都做了锁：

- 浏览器半的录音引擎从按下「开始录音」那一刻就绑定了当前会话 id；切到别的课面板时，
  ③ 里不会显示那节课的计时和「停止」，只显示「正在记另一节：某某」，也就没有按钮
  能把别人的录音停掉。缓冲区在开始/结束时清空，上一节的残留音频不会被算到下一节。
- 每次送出的片段只带自己那一节的 id；片段跑回来时若用户已经换了课，就不再改当前面板的计数。
- 宿主半只有一种情况收音频：这一节的 `recording.active` 真的是开着的（否者 409
  「这节课没在录音，这一段不收」），已结束的节更早被 409 挡住。所以停止之后迟到的片段
  不会落到任何一页上。
- 同一时刻只能有一节在录音：在 B 里按开始，A 会被自动暂停（不是结束），响应里带回
  `paused: [{id,title}]`，面板弹一句「另一节课已经停下了：某某」。

## PDF 是怎么变成 PPT 的

LibreOffice 不支持 PDF→PPTX 的转换，所以分两步走：

1. `lib/pdf.js` 调内置的 `@deepseek-ai/libreoffice-kit`，用 PDFium 把每页画成
   `page-0001.png`（150 dpi），这样版式、图、公式都原样保留；
2. `python/pdf_to_pptx.py` 用 python-pptx 组一份新 PPT：一页一张整页图，页的原文
   同时挂在这张图上（作为 alt 文本），再交给原来的解析/关键词/录音链路。

原文是关键词的唯一来源——图片里没有文字，翻页判据就靠这张图上的文字。

兜底：本机找不到 LibreOfficeKit，或渲染失败时，直接按文字排一份纯文字 PPT
（标题 + 正文），照样能识别关键词、记备注，只是看不到原来的版面。面板上会写明
「PDF 转的」和走了哪条路。

PDF 的原件会留在会话目录里（`source.pdf`），转换出来的 deck 是 `source.pptx`。

## 听写模式

每节课单独存一个 `asrMode`，录音框里点一下就换，换完从下一片开始生效：

| 模式 | 送给识别的语言 | 适合 |
| --- | --- | --- |
| 中文 | `zh` | 纯中文的课，英文词会被写成音近的中文 |
| 中英混合（默认） | `auto` | 中文讲课夹英文术语，`backpropagation`、`MSE` 这种原样留下 |
| English | `en` | 全英文的课、英文讲座 |

本机装的是 SenseVoiceSmall，认得 `auto` / `zh` / `en` / `yue` / `ja` / `ko`。
要是换了只支持少数语言的识别服务，插件会退到 `auto` 或它支持的第一个语言，
不会因为语言不认就整片失败（`lib/asr.js` 的 `resolveLanguage`）。

模式只影响转写，不影响翻页判据：中英混合转出来的英文单词照样进 `scoreKeyword` 的
拉丁词 bigram 匹配。

## 课件说英文、老师讲中文（关键词的中文说法）

英文 PPT 上写着 `backpropagation`，老师嘴里说的是「反向传播」。字面不同，
关键词匹配就永远打不中，翻页也就永远不动。所以每页的关键词都会配一份
**说出来的说法**（`keywordGlosses`：术语 → 老师会说的话），录音里听到中文也算命中。

- 上传课件时先用内置词表铺一遍（`TERM_GLOSSARY`，几百个 CS/ML 常用词，离线、零成本）；
- 开始录音时后台再跑一次模型（`POST /sessions/:id/gloss` 也能手动补），
  把课上真正会说的说法补进去，`backpropagation → 反向传播`、`weight decay → 权重衰减`；
- 面板②里每个词都显示成 `backpropagation · 反向传播`，按钮「补中文说法」可以随时重跑；
- 删掉关键词时它的说法也一起删，不会留下孤儿翻译；
- 同一个词的中英两种说法只算一次命中，不会因为说了两遍就重复加分。

方向跟着听写模式走（`lib/server.js` 的 `glossDirection`）：

| 听写模式 | 翻译方向 | 例子 |
| --- | --- | --- |
| 中文 | 英文术语 → 中文（`toZh`） | `overfitting → 过拟合` |
| 中英混合 | 两个方向都补（`both`） | `overfitting → 过拟合`、`反向传播 → backpropagation` |
| English | 中文词 → 英文（`toEn`） | `反向传播 → backpropagation` |

所以「中文课件 + 英文讲课」也能翻页。没有模型（或模型失败）时只用内置词表，
`meta.glossError` 会把原因写在面板上。

## 自动翻页怎么判

每片转写的文字会分别跟「当前页」和「下一页」的关键词打分：

- 只算下一页独有、当前页正文里没出现过的关键词（避免两页都讲的老词误伤）；
- 命中权重跟关键词长度、数字、大写缩写有关，长词命中更值钱；
- 最近两片的下一页证据加起来要过阈值，且在当前页停留够久，才真的翻；
- 没确认之前，那几句先挂起（pending），翻页时跟着一起落到新页，不会留在上一页；
- 翻页只往前走，不会自己退回来。

判据的常数都在 `lib/tracker.js` 顶部：`MIN_DWELL_MS`、`ADVANCE_MIN_SCORE`、
`CONFIRM_CHUNKS`、`WINDOW_CHUNKS`。

## AI 纪要

⑤ 里按一下「总结这节课」，当前默认模型读这节课真正听到的内容，写一份中文纪要：

- 输入是每页的页码、标题、关键词，加上落在那一页的录音文字（老师手写的补充也算），
  没有录音的页不进 prompt。转写稿里的错字病句会按上下文改掉，不会原样照抄。
- 输出固定四节：`## 一句话概括`、`## 这节课讲了什么`（按讲课顺序）、
  `## 重点与易错`、`## 复习清单`；英文术语保留原词，括号里给中文。
- 全文 400–800 字，页数多的课会按页均摊长度（`MAX_INPUT_CHARS = 14000` 封顶），
  长课不会被截成只讲前几页。
- 纪要在面板里直接排版显示（标题/段落/加粗/列表都有样式），可以「重新总结」覆盖重写。
- 导出时会把纪要追加到笔记 md 末尾的 `## AI 纪要` 一节，另外单独落一份
  `导出-听课纪要.md`，面板上给「下载纪要」。
- 录音太少（不足 40 字）会直接提示「先记一点再来总结」，不会白烧一次模型调用；
  没配默认模型、模型超时、模型返回空，都在面板上报错而不占住界面。

## 数据与文件

- 每节课一个目录：`%USERPROFILE%\.dsh\storages\class-notes\<id>\`
  （`session.json` + `source.pptx` + 导入 PDF 时的 `source.pdf` + 导出的副本）。
- 导出默认写到当前工作区；响应里同时给工作区路径和面板下载链接。
- PPT 解析与写备注走 `python/extract_pptx.py`、`python/write_notes.py`，
  PDF 转 PPT 走 `python/pdf_to_pptx.py`（依赖 `python/vendor/pypdf`），
  用 DSH 自带的 python（python-pptx）。找不到时可设 `DSH_PYTHON`。
- PDF 渲染组件的位置可用 `DSH_LIBREOFFICE_KIT` 指定，默认在
  `<resources>\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit`。

## 自带测试

```powershell
$n = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
cd dsh-plugin-class-notes
& $n test\host-e2e.mjs     # 不开浏览器，跑通解析→关键词→21 片录音→翻页→导出→幂等
& $n test\live-http.mjs    # 打真实运行中的宿主半（127.0.0.1:65039）
& $n test\pdf-import.mjs   # 造一份真 PDF → 转 PPT → 关键词（含纯文字兜底）
& $n test\live-pdf.mjs     # 走 HTTP 传 PDF，检查页数/文字/导出备注
& $n test\asr-modes.mjs     # 三档听写模式映射到识别语言（含降级）
& $n test\gloss.mjs        # 关键词的中英互译：词表/模型/打分/两个方向都能翻页
& $n test\live-gloss.mjs   # 打真实宿主半：识别关键词后 gloss 落盘、删词连带删
& $n test\live-en-deck.mjs # 英文课件 + 中文讲课，翻到第 2、3 页
& $n test\debug-en-turns.mjs # 逐片打印中文讲课在英文课件上的决策
& $n test\finish-http.mjs  # 一节=一份课件：暂停≠结束、结束后再传课件自动开新的
& $n test\live-isolation.mjs # 两节课同时开着：录音/备注/结束互不串，停了才收片
& $n test\summary.mjs      # AI 纪要：prompt 里有什么、围栏/空回答/没模型怎么处理
& $n test\live-summary.mjs # 打真实宿主半：真模型写纪要、再写一次、导出带纪要
& $n test\render-client.mjs # 不开浏览器渲染面板：13 种会话状态都画得出来，且进度只属于当前一节
& $n test\debug-turns.mjs  # 逐片打印翻页决策
& $n test\peek-keywords.mjs
& $n test\render-pages.mjs test\out\第3讲-听课笔记.pptx 1,2   # 把某几页渲染成图看效果
```

跑 PDF 相关用例时，若不在 DSH 进程里，需要先给一个 kit 路径：

```powershell
$env:DSH_LIBREOFFICE_KIT = "C:\Deep_fish\Deepseek_Harness\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\libreoffice-kit"
```

`test\demo-lecture.pptx` 是 9 页的测试课件（第 3 页带老师原备注）。

## HTTP 接口（浏览器半用的）

前缀 `/dsh-class-notes`，全部只监听 loopback：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 活着没 |
| GET | `/state` | 课程列表 + 语音/模型/PDF 渲染能力 |
| POST | `/sessions` | 新建一节课 |
| GET/PATCH/DELETE | `/sessions/:id` | 读 / 改标题课程日期 / 删 |
| POST | `/sessions/:id/deck` | 传 .pptx 或 .pdf（raw body，文件名放 `x-file-name`） |
| POST | `/sessions/:id/import-path` | 从本机路径导入（.pptx / .pdf） |
| POST | `/sessions/:id/keywords` | 识别关键词（随后自动补一遍说法） |
| POST | `/sessions/:id/gloss` | 单独补 / 重跑关键词的说法（按听写模式定方向） |
| POST | `/sessions/:id/chunk` | 送一片 16k 单声道 WAV，返回 `{text, session, decision}`；这节课没在录音就 409 |
| POST | `/sessions/:id/recording` | 开始/暂停录音（暂停不结束这一节）；开的时候会暂停别的节，返回 `paused` |
| POST | `/sessions/:id/finish` | 结束这节转录：置 `done` + `finishedAt`，之后不再收片段 |
| POST | `/sessions/:id/slides/:n` | 改关键词 / 手工备注 / 跳到这页 |
| POST | `/sessions/:id/export` | 导出 pptx + md（有纪要时再落一份纪要 md） |
| POST | `/sessions/:id/summary` | 让默认模型把这一节整理成 AI 纪要，返回 `{session, summary}` |
| POST | `/sessions/:id/speech` | 预热语音模型 |
| GET | `/sessions/:id/file?name=` | 下载导出物 |
