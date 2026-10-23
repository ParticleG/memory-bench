import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AuthStorage, completeSimple } from '@oh-my-pi/pi-ai';
import type { AssistantMessage, Context, Message as AiMessage, Tool, ToolChoice } from '@oh-my-pi/pi-ai';
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent/config/model-registry';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { getAgentDbPath } from '@oh-my-pi/pi-utils';
import { encode, decode } from 'gpt-tokenizer/encoding/o200k_base';
import type { AdapterContext, NativeHost, UsageRecord } from './types';

export const WRITER_MODEL = 'gpt-6-luna';
export const READER_MODEL = 'gpt-6-luna';
export const JUDGE_MODEL = 'gpt-6.1-sol';
export const countTokens = (text: string): number => encode(text).length;
export function truncateTokens(text: string, budget: number): string {
  const tokens = encode(text).slice(0, Math.max(0, budget));
  let truncated = decode(tokens);
  while (tokens.length && countTokens(truncated) > budget) {
    tokens.pop();
    truncated = decode(tokens);
  }
  return truncated;
}

type ChatMessage = { role: string; content?: string | null | { type: string; text?: string }[]; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
type ChatRequest = { model?: string; messages: ChatMessage[]; tools?: { function: { name: string; description?: string; parameters: unknown; strict?: boolean } }[]; tool_choice?: unknown; response_format?: { type: string; json_schema?: { schema: unknown; name?: string } }; max_tokens?: number; max_completion_tokens?: number; stream?: boolean };
const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function translate(request: ChatRequest): { context: Context; toolChoice?: ToolChoice; structured: boolean } {
  const systemPrompt: string[] = [];
  const messages: AiMessage[] = [];
  for (const message of request.messages) {
    const text = typeof message.content === 'string' ? message.content : message.content?.map(part => part.text ?? '').join('\n') ?? '';
    if (message.role === 'system' || message.role === 'developer') { systemPrompt.push(text); continue; }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = [];
      if (text) content.push({ type: 'text', text });
      for (const call of message.tool_calls ?? []) content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) });
      messages.push({ role: 'assistant', content, api: 'openai-completions', provider: 'memory-bench', model: request.model ?? WRITER_MODEL, usage: emptyUsage, stopReason: message.tool_calls?.length ? 'toolUse' : 'stop', timestamp: Date.now() });
    } else if (message.role === 'tool') {
      messages.push({ role: 'toolResult', toolCallId: message.tool_call_id ?? '', toolName: 'tool', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() });
    } else if (message.role === 'user') {
      messages.push({ role: 'user', content: text, timestamp: Date.now() });
    } else throw new Error(`Unsupported chat role: ${message.role}`);
  }
  let tools: Tool[] | undefined = request.tools?.map(({ function: fn }) => ({ name: fn.name, description: fn.description ?? '', parameters: fn.parameters as Tool['parameters'], strict: fn.strict }));
  let toolChoice = request.tool_choice as ToolChoice | undefined;
  const structured = request.response_format?.type === 'json_schema';
  if (structured) {
    if (tools?.length) throw new Error('Structured output with simultaneous function tools is not supported by this benchmark gateway');
    tools = [{ name: 'benchmark_structured_output', description: 'Return the requested structured response.', parameters: request.response_format!.json_schema!.schema as Tool['parameters'] }];
    toolChoice = { type: 'function', name: 'benchmark_structured_output' };
  } else if (request.response_format?.type === 'json_object') systemPrompt.push('Return a valid JSON object only. Do not use Markdown fences.');
  return { context: { systemPrompt, messages, tools }, toolChoice, structured };
}

export class GptRuntime {
  readonly usage: UsageRecord[] = [];
  private constructor(private auth: AuthStorage, private registry: ModelRegistry, readonly runId: string) {}
  static async create(runId: string): Promise<GptRuntime> {
    const auth = await AuthStorage.create(getAgentDbPath());
    await auth.credentials.reload();
    const registry = new ModelRegistry(auth);
    await registry.hydrateCredentialScopedModelCaches();
    return new GptRuntime(auth, registry, runId);
  }
  async chat(backend: string, purpose: string, request: ChatRequest): Promise<{ response: Record<string, unknown>; text: string }> {
    const modelId = request.model ?? WRITER_MODEL;
    if (![WRITER_MODEL, READER_MODEL, JUDGE_MODEL].includes(modelId)) throw new Error(`Model not allowed in benchmark: ${modelId}`);
    const model = this.registry.find('openai-codex', modelId);
    if (!model) throw new Error(`Configured GPT model unavailable: openai-codex/${modelId}`);
    const started = performance.now();
    const translated = translate(request);
    try {
      const result = await completeSimple(model, translated.context, {
        apiKey: this.registry.resolver(model, `memory-bench-${this.runId}`),
        maxTokens: request.max_completion_tokens ?? request.max_tokens ?? 8192,
        disableReasoning: true, hideThinkingSummary: true,
        toolChoice: translated.toolChoice,
      });
      if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage ?? `GPT ${result.stopReason}`);
      const text = result.content.filter(part => part.type === 'text').map(part => part.text).join('');
      const calls = result.content.filter(part => part.type === 'toolCall');
      const bodyText = translated.structured ? JSON.stringify(calls.find(call => call.name === 'benchmark_structured_output')?.arguments ?? (() => { throw new Error('GPT did not return required structured output'); })()) : text;
      this.usage.push({ at: new Date().toISOString(), backend, purpose, model: result.upstreamModel ?? result.model, latencyMs: performance.now() - started, inputTokens: result.usage.input, outputTokens: result.usage.output, cacheReadTokens: result.usage.cacheRead, providerEstimatedUsd: result.usage.cost?.total ?? null });
      const toolCalls = translated.structured ? [] : calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
      return { text: bodyText, response: {
        id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: bodyText || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : result.stopReason === 'length' ? 'length' : 'stop' }],
        usage: { prompt_tokens: result.usage.input + result.usage.cacheRead, completion_tokens: result.usage.output, total_tokens: result.usage.totalTokens, prompt_tokens_details: { cached_tokens: result.usage.cacheRead } },
      } };
    } catch (error) {
      this.usage.push({ at: new Date().toISOString(), backend, purpose, model: modelId, latencyMs: performance.now() - started, inputTokens: null, outputTokens: null, cacheReadTokens: null, providerEstimatedUsd: null, error: String(error) });
      throw error;
    }
  }
  async complete(backend: string, purpose: string, system: string, user: string, options: { maxTokens?: number; json?: boolean; jsonSchema?: Record<string, unknown>; model?: string } = {}): Promise<string> {
    const result = await this.chat(backend, purpose, { model: options.model ?? WRITER_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: options.maxTokens, ...(options.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'memory_benchmark_response', schema: options.jsonSchema } } } : options.json ? { response_format: { type: 'json_object' } } : {}) });
    return result.text;
  }
  async nativeHost(agentDir: string, cwd: string, backend: string): Promise<NativeHost> {
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const settings = await Settings.loadIsolated({ agentDir, cwd, overrides: { modelRoles: { default: `memory-bench/${WRITER_MODEL}`, smol: `memory-bench/${WRITER_MODEL}`, tiny: `memory-bench/${WRITER_MODEL}` } } });
    const auth = await AuthStorage.create(getAgentDbPath(agentDir));
    const registry = new ModelRegistry(auth, join(agentDir, 'models.yml'), { settings });
    registry.registerProvider('memory-bench', { baseUrl: `http://127.0.0.1:9323/${backend}/v1`, api: 'openai-completions', apiKey: 'isolated-loopback-benchmark', models: [{ id: WRITER_MODEL, name: WRITER_MODEL, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 32768, supportsTools: true }] });
    return { settings, modelRegistry: registry };
  }
}

export interface EmbeddingFunction { (texts: string[]): Promise<number[][]> }
export type BenchmarkGateway = Bun.Server<undefined>;
export function startGateway(runtime: GptRuntime, embed: EmbeddingFunction, embeddingModel: string): BenchmarkGateway {
  return Bun.serve({ hostname: '127.0.0.1', port: 9323, idleTimeout: 255, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', model: WRITER_MODEL, embeddingModel });
    const match = url.pathname.match(/^\/([a-z0-9-]+)\/v1\/(chat\/completions|embeddings|models)$/);
    if (!match) return Response.json({ error: { message: 'Unknown benchmark endpoint' } }, { status: 404 });
    const [, backend, operation] = match;
    try {
      if (operation === 'models') return Response.json({ object: 'list', data: [{ id: WRITER_MODEL, object: 'model' }] });
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (operation === 'embeddings') {
        const body = await request.json() as { input: string | string[] };
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        const vectors = await embed(texts);
        return Response.json({ object: 'list', model: embeddingModel, data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), usage: { prompt_tokens: texts.reduce((sum, text) => sum + countTokens(text), 0), total_tokens: texts.reduce((sum, text) => sum + countTokens(text), 0) } });
      }
      const body = await request.json() as ChatRequest;
      const { response } = await runtime.chat(backend, 'memory', body);
      if (!body.stream) return Response.json(response);
      const responseBody = response as { id: string; created: number; model: string; choices: { message: { content: string; tool_calls?: unknown[] }; finish_reason: string }[]; usage: unknown };
      const choice = responseBody.choices[0];
      const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => `data: ${JSON.stringify({ id: responseBody.id, object: 'chat.completion.chunk', created: responseBody.created, model: responseBody.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
      const delta = { role: 'assistant', content: choice.message.content, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls.map((call, index) => ({ ...(call as object), index })) } : {}) };
      return new Response(chunk(delta, null) + chunk({}, choice.finish_reason, responseBody.usage) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
    } catch (error) { return Response.json({ error: { message: String(error), type: 'benchmark_gateway_error' } }, { status: 502 }); }
  } });
}

export function adapterContext(runtime: GptRuntime, runId: string, workDir: string, backend: string, embeddingModel: string, embeddingDimensions: number, log: AdapterContext['log']): AdapterContext {
  return { runId, workDir, model: WRITER_MODEL, openaiBaseUrl: `http://127.0.0.1:9323/${backend}/v1`, embeddingModel, embeddingDimensions, countTokens, complete: (system, user, options) => runtime.complete(backend, 'memory', system, user, options), createNativeHost: (agentDir, cwd) => runtime.nativeHost(agentDir, cwd, backend), log };
}
