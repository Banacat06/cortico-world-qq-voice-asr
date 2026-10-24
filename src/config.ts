import type { WorldSection } from 'cortico/world.ts';

/**
 * `worlds.qq-voice` 的配置。
 *
 * 这里不存 NapCat 的协议细节（连接方向、群白名单等）——那些归 QQ World。
 * 本插件只需要两个能力：按消息号取一条语音、把 WAV 转成文字。
 */
export interface QqVoiceSection extends WorldSection {
  /** NapCat OneBot v11 的 WS 服务端地址（不是 QQ World 的反向地址）。 */
  napcatUrl: string;
  /** 直接填写 Token；留空时读 napcatTokenSecret 指向的密钥。 */
  napcatToken: string;
  /** 密钥名；值写在部署 .env，由框架 secret() 读取。 */
  napcatTokenSecret: string;
  /** 单次 NapCat 请求超时（毫秒）。 */
  timeoutMs: number;
  /** 留空 = 由本插件在本机拉起 SenseVoice；填地址则用外部 /asr 服务。 */
  asrUrl: string;
  /** 本地 ASR 服务端口，默认 8779（避开 QQ World 的 8778）。 */
  asrPort: number;
  /** Python 解释器；留空自动找 Coopanion 的 venv_vox 或 PATH。 */
  pythonPath: string;
  /** 含 model_q8.onnx / model.onnx / model.int8.onnx 与 tokens.txt 的目录。 */
  modelPath: string;
  /** 挂载时预热本地 ASR 模型。 */
  autoStart: boolean;
}

export const QQ_VOICE_DEFAULTS: QqVoiceSection = {
  enabled: false,
  napcatUrl: 'ws://127.0.0.1:3001',
  napcatToken: '',
  napcatTokenSecret: 'NAPCAT_TOKEN',
  timeoutMs: 30000,
  asrUrl: '',
  asrPort: 8779,
  pythonPath: '',
  modelPath: '',
  autoStart: true,
};
