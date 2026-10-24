/**
 * 一个很小的 NapCat / OneBot v11 客户端：只做两件事——按消息号取消息、把语音段转成 WAV。
 *
 * 为什么不复用 QQ World 的连接：QQ World 用的是「NapCat 连进来」的反向 WS，那条连接属于它；
 * 本插件连 NapCat 自己的 WS 服务端（默认 3001），是另一条独立的只读连接，不碰它的收发。
 */
export interface OneBotSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface OneBotMessage {
  message_id?: number;
  message?: OneBotSegment[] | string;
  raw_message?: string;
  message_type?: string;
  user_id?: number;
  group_id?: number;
  sender?: { nickname?: string; card?: string };
}

interface OneBotResponse<T> {
  status?: string;
  retcode?: number;
  wording?: string;
  data?: T;
  echo?: string;
}

export interface VoicePayload {
  /** NapCat 转码后的 WAV 字节（24k 单声道也能被本地 ASR 重采样）。 */
  wav: Buffer;
  /** NapCat 里的语音文件名，例如 0df9….amr。 */
  file: string;
  messageId: number;
  nickname?: string;
}

export class NapCatError extends Error {
  readonly retcode: number | undefined;

  constructor(message: string, retcode?: number) {
    super(message);
    this.name = 'NapCatError';
    this.retcode = retcode;
  }
}

/** 把模型可能传来的 "#1141799181" / "1141799181" / 1141799181 统一成数字。 */
export function normalizeMessageId(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  const m = String(raw ?? '').match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 从 get_msg 的 message / raw_message 里找 record 段的 file。 */
export function extractRecordFile(message: OneBotMessage): string | null {
  const segments = message.message;
  if (Array.isArray(segments)) {
    for (const seg of segments) {
      if (seg?.type !== 'record') continue;
      const file = typeof seg.data?.file === 'string' ? seg.data.file.trim() : '';
      if (file) return file;
    }
  }
  const raw = typeof message.raw_message === 'string'
    ? message.raw_message
    : typeof message.message === 'string'
      ? message.message
      : '';
  const m = raw.match(/\[CQ:record(?:,([^\]]*))?\]/);
  if (!m) return null;
  for (const part of (m[1] ?? '').split(',')) {
    const [key, ...rest] = part.split('=');
    if (key?.trim() === 'file') return rest.join('=').trim() || null;
  }
  return null;
}

/** 剥掉 SenseVoice 可能带出的 <|zh|> / <|NEUTRAL|> 标签和多余空白。 */
export function cleanTranscript(text: unknown): string {
  return String(text ?? '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

type WsLike = {
  addEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
  removeEventListener(type: string, fn: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(): void;
};

type WsCtor = new (url: string, init?: unknown) => WsLike;

function WebSocketCtor(): WsCtor {
  const ctor = (globalThis as { WebSocket?: WsCtor }).WebSocket;
  if (!ctor) {
    throw new NapCatError('当前 Node 没有 WebSocket（需要 Node 22 以上）。');
  }
  return ctor;
}

export class NapCatClient {
  readonly url: string;
  readonly token: string;
  readonly timeoutMs: number;
  private seq = 0;

  constructor(url: string, token: string, timeoutMs: number) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** 取一条消息的语音并转成 WAV。file 省略时先 get_msg 找 record 段。 */
  async fetchVoice(messageId: number, file?: string): Promise<VoicePayload> {
    if (!this.token) {
      throw new NapCatError(
        '没有配置 NapCat Token。请在「QQ 语音识别」的配置里填 Token，或把 NAPCAT_TOKEN 写进 Coopanion 部署的 .env。',
      );
    }
    const ws = await this.connect();
    try {
      let recordFile = (file ?? '').trim();
      let nickname: string | undefined;
      if (!recordFile) {
        const msg = (await this.call<OneBotMessage>(ws, 'get_msg', { message_id: messageId })) ?? {};
        recordFile = extractRecordFile(msg) ?? '';
        nickname = msg.sender?.card || msg.sender?.nickname || undefined;
        if (!recordFile) {
          throw new NapCatError(
            `消息 #${messageId} 里没有语音段。可能这条不是语音，或者已被 NapCat 清理；请让对方重发一条。`,
          );
        }
      }
      const rec = await this.call<{ base64?: string; file?: string; file_name?: string }>(
        ws,
        'get_record',
        { file: recordFile, out_format: 'wav' },
      );
      const b64 = typeof rec?.base64 === 'string' ? rec.base64 : '';
      if (!b64) {
        throw new NapCatError(
          `NapCat 没有返回语音音频（#${messageId}，file=${recordFile}）。可能语音已过期，或当前 NapCat 版本不支持 get_record 的 wav 输出。`,
        );
      }
      const wav = Buffer.from(b64, 'base64');
      if (wav.length < 44 || wav.subarray(0, 4).toString() !== 'RIFF') {
        throw new NapCatError(
          `NapCat 返回的音频不是 WAV（#${messageId}，${wav.length} 字节）。请确认 NapCat 支持 out_format=wav。`,
        );
      }
      return { wav, file: rec.file_name || recordFile, messageId, nickname };
    } finally {
      try { ws.close(); } catch { /* 已经断了 */ }
    }
  }

  private async connect(): Promise<WsLike> {
    const Ctor = WebSocketCtor();
    let ws: WsLike;
    try {
      // Node 的 WebSocket 支持 headers 选项；浏览器不支持，所以这里用 any 传。
      ws = new Ctor(this.url, { headers: { Authorization: `Bearer ${this.token}` } } as never);
    } catch (e) {
      throw new NapCatError(`连接 NapCat 失败：${(e as Error)?.message ?? String(e)}`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new NapCatError(
        `连接 NapCat 超时（${this.url}）。确认 NapCat 的 OneBot WS 服务端开着，端口和地址与配置一致。`,
      )), Math.min(this.timeoutMs, 10000));
      const onOpen = () => finish();
      // 401/Token 错时 undici 只给一个没有 message 的 error，随后 1006；这里给一句能操作的提示。
      const onError = () => finish(new NapCatError(
        `NapCat 拒绝了连接（${this.url}）。多半是 Token 不对：NapCat 的 WS 服务端和这里要填同一串 Token。`,
      ));
      const cleanup = () => {
        clearTimeout(timer);
        try { ws.removeEventListener('open', onOpen); } catch { /* noop */ }
        try { ws.removeEventListener('error', onError); } catch { /* noop */ }
      };
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          try { ws.close(); } catch { /* noop */ }
          reject(err);
        } else resolve();
      };
      // WsLike 的签名只写了 data 参数；open/error 事件没有 data，运行时无碍。
      ws.addEventListener('open', onOpen as never);
      ws.addEventListener('error', onError as never);
    });
    return ws;
  }

  private call<T>(ws: WsLike, action: string, params: Record<string, unknown>): Promise<T> {
    const echo = `qqv-${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new NapCatError(
        `NapCat 的 ${action} 超时（${this.timeoutMs}ms）。`,
      )), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        try { ws.removeEventListener('message', onMessage as never); } catch { /* noop */ }
        try { ws.removeEventListener('close', onClose as never); } catch { /* noop */ }
      };
      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(value as T);
      };
      const onMessage = (ev: { data?: unknown }) => {
        let msg: OneBotResponse<T>;
        try {
          msg = JSON.parse(String(ev.data)) as OneBotResponse<T>;
        } catch {
          return;
        }
        if (msg?.echo !== echo) return;
        if (msg.status === 'ok' && (msg.retcode === 0 || msg.retcode == null)) {
          finish(null, msg.data);
        } else {
          const code = msg.retcode ?? -1;
          const hint = code === 1404
            ? '（NapCat 不认识这个接口，通常是 NapCat 版本太旧）'
            : code === 1400
              ? '（参数不全；本插件用 get_record，Voice World 的 translate_record 不走这里）'
              : '';
          finish(new NapCatError(
            `NapCat ${action} 失败：retcode=${code} ${msg.wording ?? ''}${hint}`.trim(),
            code,
          ));
        }
      };
      const onClose = () => finish(new NapCatError(`NapCat 连接在 ${action} 返回前断开了。`));
      ws.addEventListener('message', onMessage as never);
      ws.addEventListener('close', onClose as never);
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        finish(new NapCatError(`向 NapCat 发送 ${action} 失败：${(e as Error)?.message ?? String(e)}`));
      }
    });
  }
}
