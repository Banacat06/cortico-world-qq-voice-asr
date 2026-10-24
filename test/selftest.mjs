import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, extractRecordFile, normalizeMessageId } from '../src/napcat.ts';

test('normalizeMessageId 接受正文里的 #数字', () => {
  assert.equal(normalizeMessageId('#1141799181'), 1141799181);
  assert.equal(normalizeMessageId(' 1141799181 '), 1141799181);
  assert.equal(normalizeMessageId(1141799181), 1141799181);
  assert.equal(normalizeMessageId('消息 #42 [语音]'), 42);
});

test('normalizeMessageId 拒绝空值和 0', () => {
  assert.equal(normalizeMessageId(''), null);
  assert.equal(normalizeMessageId(undefined), null);
  assert.equal(normalizeMessageId(0), null);
  assert.equal(normalizeMessageId('语音'), null);
});

test('extractRecordFile 从 OneBot 数组段里找 record', () => {
  const file = extractRecordFile({
    message: [
      { type: 'text', data: { text: '听' } },
      { type: 'record', data: { file: '0df9e2c893b7333663f8db21389455fc.amr', url: 'https://x' } },
    ],
  });
  assert.equal(file, '0df9e2c893b7333663f8db21389455fc.amr');
});

test('extractRecordFile 兼容 CQ 码字符串', () => {
  assert.equal(
    extractRecordFile({ raw_message: '[CQ:record,file=abc.amr,url=https://x]' }),
    'abc.amr',
  );
});

test('extractRecordFile 对非语音返回 null', () => {
  assert.equal(extractRecordFile({ message: [{ type: 'text', data: { text: 'hi' } }] }), null);
  assert.equal(extractRecordFile({ raw_message: 'hello' }), null);
});

test('cleanTranscript 去掉 SenseVoice 标签', () => {
  assert.equal(cleanTranscript('<|zh|><|NEUTRAL|>能听见吗？'), '能听见吗？');
  assert.equal(cleanTranscript('  <|en|> hello   world '), 'hello world');
  assert.equal(cleanTranscript(null), '');
});
