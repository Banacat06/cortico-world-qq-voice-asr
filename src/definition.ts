import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { QQ_VOICE_DEFAULTS, type QqVoiceSection } from './config.ts';
import { QQ_VOICE_TOOL_DECLS } from './decls.ts';
import { QqVoiceWorld } from './world.ts';

export const QQ_VOICE: WorldDefinition<QqVoiceSection> = {
  id: 'qq-voice',
  label: 'QQ 语音识别',
  defaults: () => ({ ...QQ_VOICE_DEFAULTS }),
  create: (ctx) => new QqVoiceWorld(ctx),
  describe: {
    tools: describeTools(QQ_VOICE_TOOL_DECLS, {
      qq_voice_transcribe: {
        zh: '把一条 QQ 语音消息转成文字；模型看到 [语音] 和消息号时调用。',
        en: 'Transcribes a QQ voice message when the model sees [voice] and a message id.',
      },
      qq_voice_status: {
        zh: '查看 NapCat 与本地 ASR 的就绪状态和上次失败原因。',
        en: 'Reports NapCat and local ASR readiness plus the last failure.',
      },
    }),
    events: [],
  },
};

export default QQ_VOICE;
