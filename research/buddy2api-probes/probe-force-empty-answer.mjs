// research/probe-force-empty-answer.mjs
// 复现 hermes 场景：整份回答全在 reasoning_content、content 为空。
// 试 3 组参数：不发思考相关参数 vs SSE 跳过 reasoning vs parameters 各种关思考组合。
// 关键区别：要求模型输出大 JSON（~2000 字），长输出才容易触发"全进思考"。
import { createSignerSession } from '../../lib/signer-session.js';
import { resolveGatewayEndpoint } from '../../lib/endpoint.js';
import { getValidCredential } from '../../lib/credentials-seam.js';

const credential = await getValidCredential();
const session = await createSignerSession({
  credential,
  endpoint: resolveGatewayEndpoint(credential),
});

const TEXT = `请输出一个 JSON 数组，包含 30 个对象，每个对象形如 {"id":n,"title":"条目n","detail":"这是第n条记忆的详细内容，用于测试长输出"},"done":true。只输出 JSON，不要其他文字。`;

function buildBody(text, variant) {
  const rid = globalThis.crypto.randomUUID();
  let parameters = { max_tokens: 32000 };
  let mcExtra = {};
  if (variant === 'baseline') {
    // 完全照现状（is_reasoning: false 能力位 + 无思考参数）
  } else if (variant === 'is-reasoning-true') {
    mcExtra = { is_reasoning: true };
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
      extra: { context: [], modelConfig: { key: 'pro', source: 'system', ...mcExtra }, originalContent: text },
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
      is_vl: true, is_reasoning: false, ...mcExtra, api_key: '', url: '', source: 'system',
      max_input_tokens: 180000,
    },
    messages: [{ role: 'user', content: text }],
    tools: [],
    parameters,
  });
}

async function run(variant) {
  const body = buildBody(TEXT, variant);
  const signed = session.signInferRequest(body, { modelKey: 'pro', modelSource: 'system' });
  const t0 = Date.now();
  const res = await fetch(signed.url, { method: 'POST', headers: signed.headers, body: signed.body });
  if (!res.ok) return { variant, err: `HTTP ${res.status}` };
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
  return { variant, ms: Date.now() - t0, content: content.length, reasoning: reasoning.length, code,
    signature: content.trim() === '' && reasoning.trim() !== '' ? 'THINKING-ONLY' : (reasoning.trim() === '' ? 'NO-THINKING' : 'MIXED') };
}

for (const variant of ['baseline', 'is-reasoning-true']) {
  const r = await run(variant);
  if (r.err) console.log(`${r.variant}: ❌ ${r.err}`);
  else console.log(`${r.variant}: ${((r.ms)/1000).toFixed(1)}s | 正文${r.content} 思考${r.reasoning} | ${r.signature}`);
}

await session.dispose?.();
process.exit(0);
