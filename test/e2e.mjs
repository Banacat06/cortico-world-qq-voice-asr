/**
 * 不经 Coopanion、直接把 World 跑起来的端到端测试：
 *   构造 World → 调用 qq_voice_transcribe → 自动拉起 asr_server.py → 返回文字。
 *
 * 需要 NAPCAT_TOKEN 与 MESSAGE_ID；会占用 8779。
 */
import { QqVoiceWorld } from '../src/world.ts';

const token = (process.env.NAPCAT_TOKEN || '').trim();
const messageId = Number(process.env.MESSAGE_ID || 0);
if (!token || !messageId) {
  console.error('需要 NAPCAT_TOKEN 和 MESSAGE_ID。');
  process.exit(2);
}

const cfg = {
  enabled: true,
  napcatUrl: process.env.NAPCAT_URL || 'ws://127.0.0.1:3001',
  napcatToken: token,
  napcatTokenSecret: 'NAPCAT_TOKEN',
  timeoutMs: 30000,
  asrUrl: process.env.ASR_URL || '',
  asrPort: Number(process.env.ASR_PORT || 8779),
  pythonPath: process.env.PYTHON_PATH || '',
  modelPath: process.env.MODEL_PATH || '',
  autoStart: false,
};

const ctx = {
  id: 'qq-voice',
  cfg,
  timezone: 'Asia/Shanghai',
  botName: 'test',
  botDir: '',
  packageDir: process.cwd(),
  dataDir: process.env.COOPANION_DATA || 'D:\\coopa\\Coopanion\\data\\home\\companion\\data',
  repoRoot: '',
  secret: () => '',
  storeSecret: () => {},
  persist: () => {},
  restart: async () => {},
};

const world = new QqVoiceWorld(ctx);
await world.start({});
try {
  const tool = world.tools().find((t) => t.name === 'qq_voice_transcribe');
  const out = await tool.handler({ message_id: messageId }, {
    log: { warn: (m, d) => console.log('[warn]', m, d ?? '') },
  });
  console.log('--- qq_voice_transcribe ---');
  console.log(out.text);
  if (out.failed) process.exitCode = 3;

  const status = world.tools().find((t) => t.name === 'qq_voice_status');
  console.log('--- qq_voice_status ---');
  console.log((await status.handler({}, {})).text);
} finally {
  await world.stop();
}
