# QQ 语音识别 / QQ Voice

让 Cortico bot 听懂你在 QQ 里发的语音。装在 Coopanion 上，和现有的 **QQ_bot（cortico-world-qq-final）** 并存；
不改 QQ World，不改 NapCat，也不动你的主程序。

源码：https://github.com/Banacat06/cortico-world-qq-voice-asr

## 它解决的是什么

QQ 语音消息在 NapCat 里是 **SILK v3** 编码（文件名常叫 `.amr`，内容其实是 `#!SILK_V3`）。ffmpeg
没有 SILK 解码器，所以「把语音 URL 直接喂 ffmpeg」这条路必然失败；NapCat 的 `translate_record`
在你这版里返回 `1404 unknown action`。于是 bot 只看到 `[语音]`，只能回「听不见」。

这条插件走的是另一条已经验证过的路：

```
QQ 语音（SILK）
  → NapCat get_msg(message_id)          找到 record 段的 file
  → NapCat get_record(file, wav)         NapCat 自己把 SILK 转成 24k 单声道 WAV
  → 本地 SenseVoice（sherpa-onnx）        转成文字
  → qq_voice_transcribe 工具把文字交给模型
```

实测：你 2026-10-24 17:24 发的那条语音，转写结果是「能听见吗？」。

## 为什么不直接改 QQ World

- 改 npm 包会在下次更新时被覆盖；
- QQ World 的语音链路是「先 ffmpeg 解码 URL，再调 ASR」，SILK 在第一步就死了，换 ASR 服务也救不回来；
- 这个插件不抢 QQ World 的事件，只多给模型一个工具：模型看到 `#消息号 [语音]` 时调用它，
  拿回文字再回应。两条 World 各司其职。

## 要求

- Coopanion 0.2.x（Cortico extension api 6）；
- NapCat 已开启 **OneBot v11 WS 服务端**（默认 `ws://127.0.0.1:3001`），并知道它的 access token；
- 本地有 Python + `sherpa-onnx` + `numpy`。你这台机器上 `data\extensions\venv_vox` 已经装好；
- 一个 SenseVoice 模型目录（`tokens.txt` + `model_q8.onnx` / `model.onnx` / `model.int8.onnx`）。

插件会自动找：

```
<data>\extensions\venv_vox\Scripts\python.exe
<data>\extensions\vendor\asr-model\sherpa-onnx-sense-voice
<data>\home\models\desktop-pet\sensevoice-small-int8-2024-07-17
```

找不到时在配置里手动填 `pythonPath` / `modelPath`。

## 安装

1. 把整个 `cortico-world-qq-voice` 文件夹放到任意位置；
2. 双击 `install.cmd`（或 `powershell -ExecutionPolicy Bypass -File install.ps1`）；
3. 完全退出并重启 Coopanion；
4. 打开「World 总览」，启用 **QQ 语音识别**；
5. 在「QQ 语音识别」的 **NapCat 连接** 里填 Token：
   - 直接填 `NapCat Token`，或
   - 把 `NAPCAT_TOKEN=<token>` 写进 Coopanion 部署的 `.env`，配置里只留密钥名。

NapCat Token 的位置：NapCat 设置 → 网络配置 → WS 服务端 → `accessToken`；也可以看
`C:\ProgramData\NapCatQQ Desktop\components\SnowLuma\config\onebot_<QQ号>.json` 里的
`networks.wsServers[0].accessToken`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `napcatUrl` | `ws://127.0.0.1:3001` | NapCat 的 WS **服务端**地址，不是 QQ World 的反向地址 |
| `napcatToken` | 空 | 直接填 Token；明文保存在部署 `config.json` |
| `napcatTokenSecret` | `NAPCAT_TOKEN` | 留空 `napcatToken` 时从这里读 `.env` |
| `timeoutMs` | `30000` | 单次 `get_msg` / `get_record` 超时 |
| `asrUrl` | 空 | 留空 = 本机 SenseVoice；填 `http://127.0.0.1:8778` 可复用 QQ World 的侧车 |
| `asrPort` | `8779` | 本地 ASR 端口，避开 QQ World 的 8778 |
| `pythonPath` | 空 | 留空自动找 `venv_vox` / PATH |
| `modelPath` | 空 | 留空自动找 vendored 模型或桌宠模型 |
| `autoStart` | `true` | 挂载时后台预热模型 |

改动 `asrUrl` / `asrPort` / `pythonPath` / `modelPath` 后需要重启这个 World（配置项标了非热更新）。

## 用起来是什么样

QQ 里发一条语音，QQ World 推给模型的事件仍然长这样：

```
【QQ私聊 17:24 加藤恵(QQ:1143669795)】：#1141799181 [语音]
```

模型按环境提示词调用：

```
qq_voice_transcribe(message_id = 1141799181)
```

拿到：

```
语音转写（消息 #1141799181，1.8 秒）：
「能听见吗？」

按这句话正常回应即可。不要说“听不见”，也不要向对方解释转写过程。
```

然后正常回答。群里、私聊都适用。

## 自检

包内：

```powershell
# 纯逻辑测试
node --experimental-strip-types --test test/selftest.mjs

# 真机：NapCat → WAV → 本地 ASR
$env:NAPCAT_TOKEN = '<token>'
$env:MESSAGE_ID   = '1141799181'
$env:ASR_URL      = 'http://127.0.0.1:8779'
node --experimental-strip-types test/live.mjs
```

插件装好后，也可以直接问 bot：「语音识别现在什么状态？」它会调用 `qq_voice_status`。

## 常见问题

**`NapCat 拒绝了连接` / 1006**
Token 不对，或 `napcatUrl` 填成了反向地址。填 NapCat WS 服务端的同一串 Token。

**`NapCat 没有返回语音音频`**
语音已过期、被清理，或 NapCat 版本不支持 `get_record(out_format=wav)`。让对方重发一条；
仍然失败就把 NapCat 升到当前版本。

**`找不到 Python` / `找不到 SenseVoice 模型目录`**
按错误里列出的路径，在配置里填 `pythonPath` / `modelPath`。模型目录必须同时有 `tokens.txt`
和三个 onnx 之一。

**第一次转写很慢**
第一次会加载 228MB 模型（约 1–3 秒），之后复用。`autoStart` 打开时会在后台预热。

**bot 还是不调用工具**
先确认 World 总览里「QQ 语音识别」是启用状态；再问它「语音识别状态」看 `qq_voice_status`。
环境提示词只在 World 挂载时进入前缀，改完配置要重启 World / Coopanion。

## 隐私

音频只在本机流转：NapCat → 本插件 → 本地 SenseVoice。不会上传到任何云端。
只有转写后的文字会进入模型上下文。

## 许可

MIT。`asr_server.py` 的 SenseVoice 用法与 `cortico-world-qq-final` 的本地侧车同源，按其 MIT 许可使用。
