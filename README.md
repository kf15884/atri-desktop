# Atri Desktop

Atri 的 Windows 桌面客户端。0.4 起可以**和新的 Atri（atri-self）一起看番**（见 [一起看番](docs/一起看番.md)）；同时保留给旧 Koishi / HDS 用的本人私聊镜像、桌面输入、本地分镜观察，以及可选的日语语音识别配套。

> **非官方社区扩展，试用阶段。** HDS 继续作为唯一角色大脑；本项目不创建第二套人格，不覆盖原有故事、关系或长期记忆。连接正常、资料被缓存、模型使用资料、QQ实际展示是不同的验收阶段。

## 组件

| 路径 | 版本 | 用途 |
| --- | --- | --- |
| `app/` | 0.4.0 | Electron 桌面：和 Atri 一起看番（0.4）；旧版对话框、设置、窗口/屏幕本地观察 |
| `plugin/` | 0.3.0 | `koishi-plugin-atri-desktop`，经 atri-core 连接既有 HDS |
| `asr/` | 0.1.0 | 独立日语识别配套：Whisper small、CPU/int8、日语原文转写 |
| `test/` | — | 桌面/桥接/观察回归与隔离 E2E |
| `scripts/` | — | 主机离线安装/卸载；不包含个人配置 |
| `docs/` | — | 部署、设计来源和原始交付 QA |

## 功能

- 本人桌面输入进入既有 HDS 私聊链路；镜像实际发送处理后的回复，不把无回执当成送达。
- 明确选定窗口或屏幕，约 1fps 顺序采样，变化加权选取最多 6 格，局部回看只使用过去缓存。
- 原始画面/声音留本机，约 120 秒内存缓存，最近 4 轮报告；停止清除引用，不承诺操作系统级安全擦除。
- 本地视觉使用 HTTP 回环的 OpenAI 兼容接口，默认 Ollama `qwen2.5vl:3b`；不跟随重定向或自动改云端。
- 可选 Windows 系统声音回环及本地 ASR；声音可能包含其他应用，不使用麦克风。
- 可选同步观察文字，经 core 作为本人正常回合的临时资料；不伪造用户发言，不强制推进，不直接写 HDS 数据表。

## 开发与运行

需要 Node.js、Electron 支持的 Windows x64，以及既有 Koishi/HDS/atri-core 环境。客户端依赖 Electron `38.8.6`；插件依赖 `ws 8.22.0` 和 `atri-core >=0.2.27 <0.3.0`。

```bash
cd app
npm install
npm start
```

主机安装说明见 [部署说明](docs/部署说明.md)。**离线安装脚本需要同目录的插件 TGZ**；本源码仓库不携带生产数据库、私有 HDS/core 参考包、编译后的运行环境或模型权重。不要在生产目录直接运行测试环境安装脚本，也不要用浮动 npm latest 替换既有 HDS。

`test/setup-env.sh` 需要自行提供兼容的 HDS/core 参考包；未提供时不能宣称隔离 E2E 或远程 CI 已通过。

### 日语识别（可选）

`asr/src/server.py` 是仅监听 `127.0.0.1` 的独立服务，不是 Ollama 模型。安装 `faster-whisper==1.2.1` 并准备固定 small 模型后运行：

```bash
python asr/src/download_model.py --dest /your/local/models/small
python asr/src/server.py --model-dir /your/local/models/small --port 8000 --threads 6
```

桌面填写 ASR 地址 `http://127.0.0.1:8000/v1`、模型 **`small`**（不是旧占位名 SenseVoiceSmall）。服务固定 `language=ja`、`task=transcribe`，输出日语，不自动翻译。下载步骤需要联网，推理只加载本地文件。Windows 便携包使用方法和边界见 [日语使用说明](asr/使用说明.md)。

## 状态与限制

- 桌面 0.3.0 已获主机安装、桥接就绪和 Windows 画面可见的阶段回执，不代表所有图片、重连、音频、观察同步和 QQ 端到端分支均通过。
- 日语配套已完成接口测试和 Linux CPU 真实日语样本测试；存在术语/人名误识。Windows 原生 DLL、系统回环、番剧多人对白、并行速度和停止/取消仍待实机。
- Node 24 隔离环境一次预取消 FormData 请求触发 undici 异步异常；见 [日语 QA](asr/QA.md)。未把这一分支标记通过，也未据此推断 Electron 内嵌 Node 行为。
- 当前不是实时字幕或完整观看；没有新增更多帧、跨轮重叠切片、播放器进度自动识别或全片预下载。
- 用户应检查所用模型许可、隐私和资源需求；开启文字同步后，资料可能随 HDS 请求发送给其既有模型供应商。

## 安全

请勿上传 token、API Key、Cookie、用户 QQ、聊天记录、数据库、立绘/人设私有素材、服务器配置或备份。WS 默认只监听主机 `127.0.0.1:5150`，通过自己的 SSH 隧道连接，不开放公网管理端口。文档地址均为占位示例。

## 许可与致谢

项目代码采用 MIT。HDS、Electron、Whisper 及其他依赖沿用各自许可证；本仓库不重新许可它们。

分镜阅读设计参考 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard)，为桌面实时流独立实现，不是其完整算法移植；详见 [借鉴来源](docs/借鉴来源.md)。日语识别基于 [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) 和 OpenAI Whisper，详见 [第三方声明](asr/THIRD-PARTY-NOTICES.md)。
