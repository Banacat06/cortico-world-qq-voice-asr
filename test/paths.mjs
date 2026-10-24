import { existsSync } from 'node:fs';
import { resolveAsrPaths } from '../src/paths.ts';

const packageDir = 'C:\\Users\\11436\\Documents\\deepseek-harness\\default-workspace\\cortina\\Cortina-main\\state\\packages\\cortico-world-qq-voice';
const dataDir = 'D:\\coopa\\Coopanion\\data\\home\\companion\\data';
const r = resolveAsrPaths({ packageDir, dataDir });
console.log('python:', r.python);
console.log('model:', r.modelDir);
console.log('script exists:', existsSync(r.script));
console.log('python candidates:', r.pythonCandidates);
console.log('model candidates:', r.modelCandidates);
