/**
 * 装载自检：在 Cortico 的 import 映射下实例化 World，确认 webUi()/tools()/envPrompt 路径都能跑。
 * 运行方式（在 Coopanion 的 resources\app 下）：
 *   node --import tsx --import <cortico>/src/extensions/runtime.ts test/load.mjs
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QqVoiceWorld } from '../src/world.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

const ctx = {
  id: 'qq-voice',
  cfg: {
    enabled: true,
    napcatUrl: 'ws://127.0.0.1:3001',
    napcatToken: '',
    napcatTokenSecret: 'NAPCAT_TOKEN',
    timeoutMs: 30000,
    asrUrl: '',
    asrPort: 8779,
    pythonPath: '',
    modelPath: '',
    autoStart: false,
  },
  timezone: 'Asia/Shanghai',
  botName: 'test',
  botDir: '',
  packageDir,
  dataDir: process.env.COOPANION_DATA || 'D:\\coopa\\Coopanion\\data\\home\\companion\\data',
  repoRoot: '',
  secret: () => '',
  storeSecret: () => {},
  persist: () => {},
  restart: async () => {},
};

const world = new QqVoiceWorld(ctx);
const ui = world.webUi('zh');
console.log('config groups:', ui.config.map((g) => g.id).join(', '));
console.log('tools:', world.tools().map((t) => t.name).join(', '));
console.log('env prompt:', ui.promptDocs[0].path, 'exists=', existsSync(ui.promptDocs[0].path));
console.log('lamps:', ui.lamps.map((l) => `${l.label}=${l.state}`).join(', '));
await world.start({});
await world.stop();
console.log('ok');
