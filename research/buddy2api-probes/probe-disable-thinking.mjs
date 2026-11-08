// research/probe-disable-thinking.mjs
// 对照实验：寻找真正能关闭思考的字段。用长 prompt（模拟 hermes review 场景）。
// 变体：baseline / parameters.enable_thinking:false / parameters.chat_template_kwargs / 顶层 enable_thinking
import { createSignerSession } from '../../lib/signer-session.js';
import { resolveGatewayEndpoint } from '../../lib/endpoint.js';
import { getValidCredential } from '../../lib/credentials-seam.js';

const credential = await getValidCredential();
const session = await createSignerSession({
  credential,
  endpoint: resolveGatewayEndpoint(credential),
});

// 长 prompt 复现 hermes 场景：要求输出 JSON、长上下文
const FILLER = '当前记忆条目：'.repeat(800);
const TEXT = `你是记忆回顾器。${FILLER}\n请只输出 JSON：{"ok":true,"note":"done"}`;

function buildBody(text, variant) {
  const requestId = globalThis.crypto.randomUUID();
  const rid = requestId;
  const cfg = { key: 'pro', source: 'system' };
  let parameters = { max_tokens: 32000 };
  let extra = {};
  if (variant === 'param-enable-thinking') {
    parameters = { max_tokens: 32000, enable_thinking: false };
  } else if (variant === 'param-chat-template') {
    parameters = { max_tokens: 32000, chat_template_kwargs: { enable_thinking: false } };
  } else if (variant === 'top-enable-thinking') {
    extra = { enable_thinking: false };
  } else if (variant === 'param-reasoning-effort') {
    parameters = { max_tokens: 32000, reasoning_effort: 'none' };
  }
  return JSON.stringify({
    request_id: rid,
    request_set_id: rid,
    chat_record_id: rid,
    session_id: `sess-${Date.now().toString(36)}`,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: { context: [], modelConfig: cfg, originalContent: text },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: 'qoder_work',
    aliyun_user_type: '',
    model_config: {
      key: 'pro', display_name: 'pro', model: '', format: 'openai',
      is_vl: true, is_reasoning: false, api_key: '', url: '', source: 'system',
      max_input_tokens: 180000,
    },
    messages: [{ role: 'user', content: text }],
    tools: [],
    parameters,
    ...extra,
  });
}

async function run(variant) {
  const body = buildBody(TEXT, variant);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  } catch (e) {
    return { variant, err: `网络异常: ${e.message.slice(0, 80)}` };
  }
  if (!res.ok) {
    return { variant, err: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
  }
  const decoder = new TextDecoder('utf-8');
  let buf = '', content = '', reasoning = '', code = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const evs = buf.split('\n\n'); buf = evs.pop() ?? '';
    for (const e of evs) {
      if (!e.startsWith('data:')) continue;
      const p = e.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const o = JSON.parse(p);
        const inner = typeof o.body === 'string' ? JSON.parse(o.body) : o;
        if (inner.code && String(inner.code) !== '200') code = inner.message ?? String(inner.code);
        const d = inner.choices?.[0]?.delta ?? {};
        if (d.content) content += d.content;
        if (d.reasoning_content) reasoning += d.reasoning_content;
      } catch {}
    }
  }
  return { variant, ms: Date.now() - t0, content: content.length, reasoning: reasoning.length, code, head: content.slice(0, 80) };
}

for (const variant of ['baseline', 'param-enable-thinking', 'param-chat-template', 'param-reasoning-effort', 'top-enable-thinking']) {
  const r = await run(variant);
  if (r.err) console.log(`${variant}: ❌ ${r.err}`);
  else console.log(`${variant}: HTTP200 ${((r.ms)/1000).toFixed(1)}s | 正文${r.content} 思考${r.reasoning}${r.code ? ' | code=' + r.code : ''} | ${JSON.stringify(r.head)}`);
}

await session.dispose?.();
process.exit(0);
