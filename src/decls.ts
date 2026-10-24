import type { ToolDef } from 'cortico/core/types.ts';

/**
 * 工具声明单独放一份：运行时的 world.ts 和自描述 definition.ts 都用它，避免两处文案漂移。
 */
export const QQ_VOICE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'qq_voice_transcribe',
    tags: ['read'],
    // 模型必须拿到转写结果再说话；同一条回复里排在它后面的工具调用会被跳过。
    barrierAfter: true,
    interruptible: true,
    description:
      '把一条 QQ 语音消息转成文字。'
      + '看到消息正文里出现「[语音]」并且前面带消息号（例如 `#1141799181 [语音]`）时，'
      + '先调用本工具，把那个数字传给 message_id，拿到文字后再回应。'
      + '私聊和群聊都适用。'
      + '不要猜语音内容，也不要在调用之前就说「听不见」「语音功能没开」；先试这个工具。'
      + '工具失败时如实告诉对方没转写成功，请对方重发或打字，不要编造内容。',
    parameters: {
      type: 'object',
      properties: {
        message_id: {
          type: 'integer',
          minimum: 1,
          description: '语音消息的 QQ 消息号，就是正文里 # 后面那串数字。',
        },
      },
      required: ['message_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_voice_status',
    tags: ['read', 'snapshot'],
    description:
      '查看 QQ 语音识别插件的状态：NapCat 连接参数是否齐全、本地转写服务是否就绪、上次成功或失败的原因。'
      + '只在对方问「语音识别怎么了 / 为什么听不见」或转写连续失败时调用；平时不要主动查。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];
