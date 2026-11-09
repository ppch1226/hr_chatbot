/**
 * LLM 호출 (OpenRouter, OpenAI 호환 Chat Completions)
 */
const BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const MODEL = () => process.env.LLM_MODEL || 'openai/gpt-4.1-mini';
const KEY = () => (process.env.OPENROUTER_API_KEY || '').trim();

async function chat(messages, { temperature = 0.1, maxTokens = 1500, json = false } = {}) {
  if (!KEY()) throw new Error('.env에 OPENROUTER_API_KEY를 설정하세요.');
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY()}`,
      'Content-Type': 'application/json',
      'X-Title': 'HR Happy AI',
    },
    body: JSON.stringify({
      model: MODEL(),
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`LLM 호출 실패 (${r.status}): ${(j.error && j.error.message) || 'unknown'}`);
  return { text: j.choices?.[0]?.message?.content || '', usage: j.usage, model: j.model };
}

/**
 * 스트리밍 호출: 토큰이 생성되는 대로 onDelta(text) 호출. 끝나면 전체 텍스트 반환
 * (OpenRouter SSE: "data: {choices:[{delta:{content}}]}" 줄 단위, 마지막 "data: [DONE]")
 */
async function chatStream(messages, { temperature = 0.1, maxTokens = 1500, onDelta } = {}) {
  if (!KEY()) throw new Error('.env에 OPENROUTER_API_KEY를 설정하세요.');
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json', 'X-Title': 'HR Happy AI' },
    body: JSON.stringify({ model: MODEL(), messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`LLM 호출 실패 (${r.status}): ${(j.error && j.error.message) || 'unknown'}`);
  }
  const decoder = new TextDecoder();
  let buf = '', text = '', usage, model;
  for await (const part of r.body) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" 같은 주석 줄 무시
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta?.content || '';
        if (j.usage) usage = j.usage;
        if (j.model) model = j.model;
        if (d) {
          text += d;
          onDelta && onDelta(d);
        }
      } catch {}
    }
  }
  return { text, usage, model };
}

module.exports = { chat, chatStream, MODEL, configured: () => !!KEY() };
