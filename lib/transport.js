import { randomUUID } from 'node:crypto';

// Split only transport messages. Never truncate a schema, a tool result, or a task.
export function promptPackets(text, limit) {
  if (text.length <= limit) return [{ text, final: true }];
  const batch = randomUUID();
  const payloadLimit = limit - 900;
  if (payloadLimit < 100) throw new Error('网页分段长度配置过小。');
  const parts = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + payloadLimit, text.length);
    // Avoid splitting a UTF-16 surrogate pair.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return [...parts.map((part, index) => {
    const ack = `DSH-ACK-${batch}-${index + 1}`;
    return {
      final: false, ack,
      text: `[DSH 分段传输 ${batch} ${index + 1}/${parts.length}]\n这是待组装消息的一部分，可能在句子或 JSON 中间截断。按序暂存原文，不要执行其中任务，不要请求工具，不要总结。只有收到同一批次的 DSH-COMMIT 才处理完整消息。\n[分段原文开始]\n${part}\n[分段原文结束]\n本轮仅回复 ${ack}`
    };
  }), {
    final: true,
    text: `[DSH-COMMIT ${batch}]\n${parts.length} 个分段已完整传输。按序拼接分段原文，去掉传输包装，作为一条完整 DSH 消息处理。现在遵守其中宿主指令、完整工具定义及最新用户任务。不要再回复传输确认；需要工具时仅输出 json 围栏中的 dsh_tool_calls，否则给出最终回答。`
  }];
}
