import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveAsrPaths } from './paths.ts';

export type AsrState = 'idle' | 'loading' | 'online' | 'error';

export interface AsrStatus {
  state: AsrState;
  detail: string;
  model: string;
  port: number;
  external: boolean;
}

export interface AsrOptions {
  packageDir: string;
  dataDir: string;
  /** 外部服务地址；留空用本地。 */
  url: string;
  port: number;
  pythonPath: string;
  modelPath: string;
  autoStart: boolean;
  timeoutMs: number;
  log: (msg: string, data?: unknown) => void;
}

/**
 * 本地 SenseVoice 服务：第一次转写时拉起 Python 侧车，之后复用；退出后下次自动重拉。
 *
 * 进程不设 detached：Coopanion 退出时子进程跟着结束，避免留下一个占着 8779 的孤儿。
 * 启动只透传跑 Python 必需的少量环境变量，不把部署里的密钥带进子进程。
 */
export class AsrService {
  private readonly opts: AsrOptions;
  private child: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private state: AsrState = 'idle';
  private detail = '尚未启动';
  private resolvedModel = '';
  private readonly logPath: string;

  constructor(opts: AsrOptions) {
    this.opts = opts;
    this.logPath = join(opts.dataDir, 'qq-voice-asr.log');
  }

  get external(): boolean {
    return this.opts.url.trim() !== '';
  }

  get base(): string {
    const external = this.opts.url.trim();
    return (external || `http://127.0.0.1:${this.opts.port}`).replace(/\/+$/, '');
  }

  status(): AsrStatus {
    return {
      state: this.state,
      detail: this.detail,
      model: this.resolvedModel ? basename(this.resolvedModel) : '',
      port: this.opts.port,
      external: this.external,
    };
  }

  /** 确保服务可用：外部地址只探活；本地按需拉起并等 /health ready。 */
  async ensure(): Promise<void> {
    if (await this.healthy()) {
      this.state = 'online';
      this.detail = this.external ? '外部服务已就绪' : '本地服务已就绪';
      return;
    }
    if (this.external) {
      this.state = 'error';
      this.detail = `外部 ASR 不可用：${this.base}`;
      throw new Error(
        `外部 ASR 服务没有就绪（${this.base}/health）。把它启动，或把「语音模型服务地址」留空改用本机 SenseVoice。`,
      );
    }
    // autoStart 只决定挂载时是否预热；第一次转写时仍然按需拉起。
    if (this.starting) return this.starting;
    this.starting = this.startLocal().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** 把 WAV 字节交给服务；返回识别文本（可能为空串）。 */
  async transcribe(wav: Uint8Array): Promise<string> {
    await this.ensure();
    let res: Response;
    try {
      res = await fetch(`${this.base}/asr`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wav as unknown as BodyInit,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (e) {
      this.state = 'error';
      this.detail = `ASR 请求失败：${(e as Error)?.message ?? String(e)}`;
      throw new Error(
        `调用本地 ASR 失败（${this.base}/asr）：${(e as Error)?.message ?? String(e)}。看 ${this.logPath} 里的服务日志。`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.state = 'error';
      this.detail = `ASR HTTP ${res.status}`;
      throw new Error(`本地 ASR 返回 HTTP ${res.status}：${body.slice(0, 300)}`);
    }
    const data = await res.json().catch(() => null) as { text?: unknown } | null;
    const text = typeof data?.text === 'string' ? data.text : '';
    this.state = 'online';
    this.detail = '已就绪';
    return text;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.state = 'idle';
    this.detail = '已停止';
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        finish();
      }, 2500);
      child.once('exit', () => { clearTimeout(timer); finish(); });
      try { child.kill(); } catch { clearTimeout(timer); finish(); }
    });
  }

  /** 只探活，不拉起。 */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return false;
      const j = await res.json().catch(() => null) as { ready?: unknown } | null;
      return j?.ready === true;
    } catch {
      return false;
    }
  }

  private async startLocal(): Promise<void> {
    const paths = resolveAsrPaths({
      packageDir: this.opts.packageDir,
      dataDir: this.opts.dataDir,
      pythonPath: this.opts.pythonPath,
      modelPath: this.opts.modelPath,
    });
    if (!existsSync(paths.script)) {
      throw new Error(`插件缺少 asr_server.py：${paths.script}`);
    }
    if (!paths.python) {
      throw new Error(
        '找不到 Python。请在配置里填 pythonPath，或把 Coopanion 的 venv_vox 放在 data\\extensions\\venv_vox。'
        + `找过：${paths.pythonCandidates.join('；')}`,
      );
    }
    if (!paths.modelDir) {
      throw new Error(
        '找不到 SenseVoice 模型目录（需要 tokens.txt 和 model_q8.onnx / model.onnx / model.int8.onnx）。'
        + '请在配置里填 modelPath。找过：'
        + paths.modelCandidates.join('；'),
      );
    }
    if (await this.healthy()) {
      this.state = 'online';
      this.detail = '本地服务已在运行';
      return;
    }
    this.state = 'loading';
    this.detail = `正在加载 ${basename(paths.modelDir)}…`;
    this.resolvedModel = paths.modelDir;
    const fd = openSync(this.logPath, 'a');
    let child: ChildProcess;
    try {
      child = spawn(
        paths.python,
        [paths.script, '--port', String(this.opts.port), '--model-dir', paths.modelDir],
        {
          cwd: this.opts.packageDir,
          env: {
            PATH: process.env.PATH || '',
            SYSTEMROOT: process.env.SYSTEMROOT || '',
            SYSTEMDRIVE: process.env.SYSTEMDRIVE || '',
            TEMP: process.env.TEMP || '',
            TMP: process.env.TMP || '',
            HOME: process.env.HOME || '',
            LANG: process.env.LANG || '',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
          },
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        },
      );
    } finally {
      closeSync(fd);
    }
    this.child = child;
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        if (this.state === 'online' || this.state === 'loading') {
          this.state = 'error';
          this.detail = `服务退出（code=${code} signal=${signal}）`;
          this.opts.log('[qq-voice] 本地 ASR 服务退出', { code, signal });
        }
      }
    });
    child.once('error', (err) => {
      this.state = 'error';
      this.detail = `拉起失败：${err.message}`;
      if (this.child === child) this.child = null;
      this.opts.log('[qq-voice] 本地 ASR 拉起失败', String(err));
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await this.healthy()) {
        this.state = 'online';
        this.detail = '本地服务已就绪';
        return;
      }
      if (this.child?.exitCode != null || this.child?.signalCode != null || !this.child) {
        this.state = 'error';
        this.detail = '本地服务启动失败';
        break;
      }
      await sleep(600);
    }
    throw new Error(
      `本地 ASR 服务没有在 90 秒内就绪。看日志：${this.logPath}\n${this.logTail()}`,
    );
  }

  private logTail(): string {
    try {
      const text = readFileSync(this.logPath, 'utf8');
      return text.slice(-2000);
    } catch {
      return '（日志还没写出来）';
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
