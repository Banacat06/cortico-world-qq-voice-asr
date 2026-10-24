/**
 * 真机诊断：拿一条真实 QQ 语音，走 NapCat get_record → WAV → 本地 ASR。
 *
 * 用法（PowerShell）：
 *   $env:NAPCAT_TOKEN = '...'
 *   $env:MESSAGE_ID   = '1141799181'
 *   $env:ASR_URL      = 'http://127.0.0.1:8779'   # 或 8778（QQ World 的侧车）
 *   node --experimental-strip-types test/live.mjs
 *
 * 这个脚本不读配置文件，不打印 Token；只用于装进实例前确认三段链路都通。
 */
import { NapCatClient } from '../src/napcat.ts';

const token = (process.env.NAPCAT_TOKEN || '').trim();
const messageId = Number(process.env.MESSAGE_ID || process.argv[2] || 0);
const napcatUrl = (process.env.NAPCAT_URL || 'ws://127.0.0.1:3001').trim();
const asrUrl = (process.env.ASR_URL || 'http://127.0.0.1:8779').replace(/\/+$/, '');

if (!token) {
  console.error('缺少 NAPCAT_TOKEN 环境变量。');
  process.exit(2);
}
if (!messageId) {
  console.error('缺少 MESSAGE_ID（或第一个参数）。');
  process.exit(2);
}

const client = new NapCatClient(napcatUrl, token, 30000);
console.log(`NapCat ${napcatUrl}；消息 #${messageId}`);
const voice = await client.fetchVoice(messageId);
console.log(`拿到 WAV：${voice.file}，${voice.wav.length} 字节`);

const res = await fetch(`${asrUrl}/asr`, {
  method: 'POST',
  headers: { 'content-type': 'audio/wav' },
  body: voice.wav,
});
if (!res.ok) {
  console.error(`ASR HTTP ${res.status}: ${await res.text()}`);
  process.exit(3);
}
const data = await res.json();
console.log('转写结果：' + (data.text || '（空）'));
if (!data.text) process.exit(4);
