import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { QQ_VOICE_DEFAULTS, type QqVoiceSection } from './config.ts';
import { QQ_VOICE_TOOL_DECLS } from './decls.ts';
import { AsrService } from './asr.ts';
import { cleanTranscript, NapCatClient, normalizeMessageId } from './napcat.ts';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENV_PROMPT_FILE = join(PACKAGE_DIR, 'ENV_PROMPT.md');

/**
 * QQ 语音识别 World。
 *
 * 它不接管 QQ 消息，也不和 QQ World 抢连接：QQ World 照旧把 `[语音]` 推给模型，
 * 本插件只多给模型一个 `qq_voice_transcribe` 工具。模型看到 `#消息号 [语音]` 时调用它，
 * 这里用 NapCat 的 get_record(out_format=wav) 把 SILK 转成 WAV，再交给本地 SenseVoice。
 */
export class QqVoiceWorld implements World {
  readonly id = 'qq-voice';
  private host: WorldHost | null = null;
  private readonly ctx: WorldContext<QqVoiceSection>;
  private readonly asr: AsrService;
  private napcat: NapCatClient | null = null;
  private napcatKey = '';
  private lastError = '';
  private lastErrorAt = 0;
  private lastOk = '';
  private lastOkAt = 0;
  private lastMs = 0;
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: WorldContext<QqVoiceSection>) {
    this.ctx = ctx;
    this.asr = new AsrService({
      // 不用 ctx.packageDir：框架有时把它指向 bots/<bot>。模块自己的位置才是扩展包根。
      packageDir: PACKAGE_DIR,
      dataDir: ctx.dataDir,
      url: ctx.cfg.asrUrl,
      port: ctx.cfg.asrPort,
      pythonPath: ctx.cfg.pythonPath,
      modelPath: ctx.cfg.modelPath,
      autoStart: ctx.cfg.autoStart,
      timeoutMs: 120_000,
      log: (msg, data) => console.warn(msg, data ?? ''),
    });
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 预热放在后台：启动 Coopanion 时不要因为加载 228MB 模型卡住其他 World。
    if (this.ctx.cfg.autoStart && !this.ctx.cfg.asrUrl.trim()) {
      this.warmupTimer = setTimeout(() => {
        this.warmupTimer = null;
        void this.asr.ensure().catch((e) => this.noteError(e));
      }, 2500);
      (this.warmupTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    this.host = null;
    await this.asr.stop();
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return QQ_VOICE_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: async (args, callCtx) => {
        if (decl.name === 'qq_voice_transcribe') return this.transcribe(args, callCtx);
        return this.status();
      },
    }));
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    void language;
    const asr = this.asr.status();
    const state: 'online' | 'loading' | 'error' | 'offline' = asr.state === 'online'
      ? 'online'
      : asr.state === 'loading'
        ? 'loading'
        : asr.state === 'error'
          ? 'error'
          : 'offline';
    return {
      label: 'QQ 语音识别',
      lamps: [
        {
          label: '本地转写',
          state,
          hint: asr.detail + (asr.model ? `（${asr.model}）` : ''),
        },
      ],
      promptDocs: [
        {
          key: 'worlds.qq-voice.envPrompt',
          title: 'QQ 语音识别环境提示词',
          description: '告诉模型：看到 [语音] 和 #消息号 时先用 qq_voice_transcribe，不要猜内容。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      config: configGroups(this.ctx.dataDir),
    };
  }

  private async transcribe(
    args: Record<string, unknown>,
    callCtx: ToolCallContext,
  ): Promise<ToolOutcome> {
    const messageId = normalizeMessageId(args.message_id);
    if (!messageId) {
      return {
        text: '需要一个 QQ 语音消息号。消息正文里的 `#1141799181 [语音]` 中，1141799181 就是。',
        failed: true,
      };
    }
    if (callCtx.signal?.aborted) return { text: '语音转写已取消。', failed: true };

    const cfg = this.ctx.cfg;
    const token = this.resolveToken();
    if (!token) {
      return {
        text: `没有配置 NapCat Token，暂时无法转写语音。\n`
          + `请在「QQ 语音识别」设置里填 Token，或把密钥 ${cfg.napcatTokenSecret || 'NAPCAT_TOKEN'} 写进 Coopanion 部署的 .env。`,
        failed: true,
      };
    }

    const client = this.napcatFor(cfg, token);
    const t0 = Date.now();
    try {
      const voice = await client.fetchVoice(messageId);
      if (callCtx.signal?.aborted) return { text: '语音转写已取消。', failed: true };
      const raw = await this.asr.transcribe(voice.wav);
      const text = cleanTranscript(raw);
      const ms = Date.now() - t0;
      this.lastMs = ms;
      this.lastOkAt = Date.now();
      this.lastOk = `#${messageId}${text ? `：${text.slice(0, 60)}` : '（空）'}`;
      this.lastError = '';
      if (!text) {
        return {
          text: `消息 #${messageId} 的语音没有识别出文字（可能是环境噪音、音乐、太短或没说话）。\n`
            + '不要猜内容；可以请对方再说一遍或打字。',
        };
      }
      callCtx.log?.warn?.(`[qq-voice] 转写 #${messageId} 用时 ${ms}ms：${text.slice(0, 80)}`);
      return {
        text: `语音转写（消息 #${messageId}，${(ms / 1000).toFixed(1)} 秒）：\n「${text}」\n\n`
          + '按这句话正常回应即可。不要说“听不见”，也不要向对方解释转写过程。',
      };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.noteError(e);
      callCtx.log?.warn?.(`[qq-voice] 转写 #${messageId} 失败：${msg}`);
      return {
        text: `语音识别失败：${msg}\n\n`
          + '如实告诉对方这次没转写成功，请对方重发或打字；不要编造语音内容。',
        failed: true,
      };
    }
  }

  private status(): ToolOutcome {
    const cfg = this.ctx.cfg;
    const asr = this.asr.status();
    const token = this.resolveToken();
    const lines = [
      `NapCat 地址：${cfg.napcatUrl || '（空）'}`,
      `NapCat Token：${token ? '已配置' : '未配置'}`,
      `本地转写：${asr.state} — ${asr.detail}`,
      asr.model ? `模型：${asr.model}` : '模型：未找到',
      asr.external ? `外部服务：${cfg.asrUrl}` : `本地端口：${cfg.asrPort}`,
    ];
    if (this.lastOk) {
      lines.push(`上次成功：${this.lastOk}${this.lastOkAt ? `（${new Date(this.lastOkAt).toLocaleTimeString('zh-CN')}）` : ''}`);
      if (this.lastMs) lines.push(`上次用时：${(this.lastMs / 1000).toFixed(1)} 秒`);
    }
    if (this.lastError) {
      lines.push(`上次错误：${this.lastError}${this.lastErrorAt ? `（${new Date(this.lastErrorAt).toLocaleTimeString('zh-CN')}）` : ''}`);
    }
    return { text: lines.join('\n') };
  }

  private resolveToken(): string {
    const cfg = this.ctx.cfg;
    const direct = (cfg.napcatToken || '').trim();
    if (direct) return direct;
    const name = (cfg.napcatTokenSecret || '').trim();
    if (!name) return '';
    try {
      return (this.ctx.secret(name) || '').trim();
    } catch {
      return '';
    }
  }

  private napcatFor(cfg: QqVoiceSection, token: string): NapCatClient {
    const url = (cfg.napcatUrl || '').trim() || 'ws://127.0.0.1:3001';
    const timeout = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs >= 5000 ? cfg.timeoutMs : 30_000;
    const key = `${url}|${token}|${timeout}`;
    if (!this.napcat || this.napcatKey !== key) {
      this.napcat = new NapCatClient(url, token, timeout);
      this.napcatKey = key;
    }
    return this.napcat;
  }

  private noteError(e: unknown): void {
    this.lastError = (e as Error)?.message ?? String(e);
    this.lastErrorAt = Date.now();
    this.lastOk = '';
  }
}

function configGroups(dataDir: string): ConfigGroup[] {
  const extensions = resolve(dataDir, '..', '..', '..', 'extensions');
  return [
    {
      id: 'connection',
      owner: 'world:qq-voice',
      schema: {
        type: 'object',
        title: 'NapCat 连接',
        description: '本插件连 NapCat 的 OneBot WS 服务端（NapCat 设置里的「WS 服务端」），和 QQ World 的反向连接是两条不同的线。',
        properties: {
          'worlds.qq-voice.napcatUrl': {
            type: 'string',
            title: 'NapCat WS 地址',
            description: '默认 ws://127.0.0.1:3001；端口以 NapCat 的 WS 服务端设置为准。',
            'x-hot': true,
          },
          'worlds.qq-voice.napcatToken': {
            type: 'string',
            title: 'NapCat Token',
            description: '直接填 NapCat WS 服务端的 access token。明文保存在部署 config.json；想放到 .env 就留空，改用下面的密钥名。',
            'x-hot': true,
          },
          'worlds.qq-voice.napcatTokenSecret': {
            type: 'string',
            title: 'Token 密钥名',
            description: '默认 NAPCAT_TOKEN。值写在 Coopanion 部署的 .env，代码经框架 secret() 读取。',
            'x-hot': true,
          },
          'worlds.qq-voice.timeoutMs': {
            type: 'integer',
            title: '请求超时（毫秒）',
            description: '单次 get_msg / get_record 的等待上限。',
            minimum: 5000,
            maximum: 120000,
            'x-hot': true,
          },
        },
      },
    },
    {
      id: 'asr',
      owner: 'world:qq-voice',
      schema: {
        type: 'object',
        title: '语音识别',
        description: '默认在本机拉起 SenseVoice（需要 Python + sherpa-onnx + 模型）。也可以填一个已有的 /asr 服务。',
        properties: {
          'worlds.qq-voice.asrUrl': {
            type: 'string',
            title: '外部 ASR 地址',
            description: '留空 = 本机 SenseVoice。填 http://127.0.0.1:8778 这类地址则直接用外部服务（需提供 GET /health 与 POST /asr，/asr 收裸 WAV）。',
            'x-hot': false,
          },
          'worlds.qq-voice.asrPort': {
            type: 'integer',
            title: '本地端口',
            description: '默认 8779，避开 QQ World 的 8778。',
            minimum: 1024,
            maximum: 65535,
            'x-hot': false,
          },
          'worlds.qq-voice.pythonPath': {
            type: 'string',
            title: 'Python 路径',
            description: `留空自动找 ${join(extensions, 'venv_vox', 'Scripts', 'python.exe')}。`,
            'x-path': { kind: 'file', extensions: ['exe'] },
            'x-hot': false,
          },
          'worlds.qq-voice.modelPath': {
            type: 'string',
            title: 'SenseVoice 模型目录',
            description: '需要 tokens.txt 与 model_q8.onnx / model.onnx / model.int8.onnx。留空自动找 data\\extensions\\vendor\\asr-model 或桌宠模型。',
            'x-path': { kind: 'directory' },
            'x-hot': false,
          },
          'worlds.qq-voice.autoStart': {
            type: 'boolean',
            title: '自动启动并预热',
            description: '挂载时在后台拉起本地服务；关掉则第一次转写时才启动。',
            'x-hot': false,
          },
        },
      },
    },
  ];
}

// 默认值同时给 WorldDefinition 用；这里保留一个具名导出，方便测试与文档对照。
export { QQ_VOICE_DEFAULTS };
