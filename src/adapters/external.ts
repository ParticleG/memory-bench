import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import type { MastraDBMessage } from '@mastra/core/agent';
import type { OpenAICompatibleConfig } from '@mastra/core/llm';
import type { ObservationalMemoryRecord } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

import type {
  AdapterContext,
  AdapterFactory,
  Corpus,
  Document,
  MemoryAdapter,
  MemoryItem,
  RecallQuery,
  Retrieval,
} from '../types';

const DEFAULT_EMBEDDING_MODEL = 'intfloat/multilingual-e5-large';
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
/**
 * The loopback gateway is unauthenticated and binds only 127.0.0.1. OpenAI
 * clients still require a non-empty value, so this explicit marker is sent.
 * No provider key is read or forwarded.
 */
const GATEWAY_API_KEY = 'memory-bench-loopback';

const MASTRA_OBSERVATION_MESSAGE_TOKENS = 30_000;
const MASTRA_REFLECTION_OBSERVATION_TOKENS = 40_000;
const MEM0_TOP_K = 30;
const MEM0_THRESHOLD = 0.1;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..', '..');
const workerPath = path.join(projectRoot, 'python', 'worker.py');
const venvPython = path.join(projectRoot, '.venv', 'bin', 'python');

function embeddingCacheDir(context: AdapterContext): string {
  return (
    process.env.BENCH_EMBEDDING_CACHE?.trim() ||
    path.join(context.workDir, 'models', 'fastembed')
  );
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'run';
}

function resolvePythonCommand(): { command: string; argsPrefix: string[] } {
  if (existsSync(venvPython)) {
    return { command: venvPython, argsPrefix: [] };
  }
  return {
    command: 'uv',
    argsPrefix: ['run', '--project', projectRoot, '--frozen', 'python'],
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

class PythonWorkerError extends Error {
  readonly type: string;
  readonly traceback: string;

  constructor(message: string, type: string, traceback: string) {
    super(message);
    this.name = 'PythonWorkerError';
    this.type = type;
    this.traceback = traceback;
  }
}

interface PythonWorkerOptions {
  context: AdapterContext;
  cacheDir: string;
  mem0Dir?: string;
  model: string;
  extraArgs?: string[];
}

/** A single Python child process speaking newline-delimited JSON. */
class PythonWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private stderrTail = '';
  private nextId = 1;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null =
    null;
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(private readonly options: PythonWorkerOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get tail(): string {
    return this.stderrTail;
  }

  async start(timeoutMs = 60_000): Promise<void> {
    if (this.child) return;
    const { command, argsPrefix } = resolvePythonCommand();
    const args = [
      ...argsPrefix,
      workerPath,
      '--cache-dir',
      this.options.cacheDir,
      '--model',
      this.options.model,
      ...(this.options.mem0Dir ? ['--mem0-dir', this.options.mem0Dir] : []),
      ...(this.options.extraArgs ?? []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MEM0_TELEMETRY: 'false',
      MEM0_DIR: this.options.mem0Dir ?? path.join(this.options.context.workDir, 'mem0'),
      FASTEMBED_CACHE_PATH: this.options.cacheDir,
      HF_HUB_DISABLE_TELEMETRY: '1',
      HF_HUB_DISABLE_PROGRESS_BARS: '1',
      TQDM_DISABLE: '1',
      PYTHONUNBUFFERED: '1',
      TOKENIZERS_PARALLELISM: 'false',
    };
    delete env.OPENAI_API_KEY;
    this.options.context.log('python.worker.start', {
      command,
      args: args.slice(argsPrefix.length),
      model: this.options.model,
    });
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.exitInfo = null;
    child.stdin.on('error', (error) => {
      this.options.context.log('python.worker.stdin_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const exited = Promise.withResolvers<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>();
    this.exitPromise = exited.promise;
    child.once('exit', (code, signal) => {
      this.exitInfo = { code, signal };
      const error = new Error(
        `Python worker exited with code ${String(code)} signal ${String(signal)}` +
          (this.stderrTail ? `\n${this.stderrTail}` : ''),
      );
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
      this.emitter.emit('exit', this.exitInfo);
      exited.resolve(this.exitInfo!);
    });

    const stdout = createInterface({ input: child.stdout, terminal: false });
    stdout.on('line', (line) => this.handleStdoutLine(line));
    const stderr = createInterface({ input: child.stderr, terminal: false });
    stderr.on('line', (line) => {
      this.stderrTail = `${this.stderrTail}${line}\n`.slice(-65_536);
      this.options.context.log('python.worker.stderr', { line });
    });

    const started = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      started.reject(
        new Error(
          `Python worker did not start within ${timeoutMs}ms` +
            (this.stderrTail ? `\n${this.stderrTail}` : ''),
        ),
      );
    }, timeoutMs);
    child.once('spawn', () => {
      clearTimeout(timer);
      started.resolve();
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      started.reject(error);
    });
    await started.promise;
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.options.context.log('python.worker.unexpected_stdout', { line: trimmed });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const record = parsed as Record<string, unknown>;
    if (typeof record.event === 'string') {
      this.emitter.emit(record.event, record);
      return;
    }
    const id = String(record.id ?? '');
    const pending = this.pending.get(id);
    if (!pending) {
      this.options.context.log('python.worker.unmatched_response', {
        id,
        ok: record.ok,
      });
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.ok === true) {
      pending.resolve(record.result);
      return;
    }
    const error = (record.error ?? {}) as Record<string, unknown>;
    pending.reject(
      new PythonWorkerError(
        String(error.message ?? 'Python worker request failed'),
        String(error.type ?? 'PythonWorkerError'),
        String(error.traceback ?? ''),
      ),
    );
  }

  once(event: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const waiter = Promise.withResolvers<Record<string, unknown>>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = (payload: Record<string, unknown>) => {
      clearTimeout(timer);
      waiter.resolve(payload);
    };
    timer = setTimeout(() => {
      this.emitter.off(event, handler);
      waiter.reject(
        new Error(
          `Python worker did not emit ${event} within ${timeoutMs}ms` +
            (this.stderrTail ? `\n${this.stderrTail}` : ''),
        ),
      );
    }, timeoutMs);
    this.emitter.once(event, handler);
    return waiter.promise;
  }

  async request<T>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.child) throw new Error('Python worker is not running');
    if (this.exitInfo) {
      throw new Error(
        `Python worker already exited with code ${String(this.exitInfo.code)}` +
          (this.stderrTail ? `\n${this.stderrTail}` : ''),
      );
    }
    const id = String(this.nextId++);
    const body = `${JSON.stringify({ id, ...payload })}\n`;
    const deferred = Promise.withResolvers<T>();
    const pending: PendingRequest = {
      resolve: (value) => deferred.resolve(value as T),
      reject: deferred.reject,
    };
    if (timeoutMs && timeoutMs > 0) {
      pending.timer = setTimeout(() => {
        this.pending.delete(id);
        deferred.reject(
          new Error(
            `Python worker request ${String(payload.op)} timed out after ${timeoutMs}ms` +
              (this.stderrTail ? `\n${this.stderrTail}` : ''),
          ),
        );
      }, timeoutMs);
    }
    this.pending.set(id, pending);
    this.child!.stdin.write(body, (error) => {
      if (!error) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      deferred.reject(error);
    });
    return deferred.promise;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.exitInfo) {
      try {
        await this.request({ op: 'close' }, 30_000);
      } catch (error) {
        this.options.context.log('python.worker.close_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      child.stdin.end();
      await Promise.race([this.exitPromise ?? Promise.resolve(null), delay(5_000)]);
    }
    if (!this.exitInfo) {
      child.kill('SIGKILL');
      await Promise.race([this.exitPromise ?? Promise.resolve(null), delay(1_000)]);
    }
    this.child = null;
  }

  async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.exitInfo) {
      child.kill('SIGTERM');
      await Promise.race([this.exitPromise ?? Promise.resolve(null), delay(5_000)]);
    }
    if (!this.exitInfo) {
      child.kill('SIGKILL');
      await Promise.race([this.exitPromise ?? Promise.resolve(null), delay(1_000)]);
    }
    this.child = null;
  }
}

export interface PythonEmbeddingService {
  url: string;
  openaiBaseUrl: string;
  model: string;
  dimensions: number;
  pid: number | null;
  close: () => Promise<void>;
}

/**
 * Start the shared FastEmbed HTTP service used by the benchmark gateway.
 * The returned URL is an OpenAI-compatible base (append `/v1/embeddings`).
 */
export async function startPythonEmbeddingService(
  context: AdapterContext,
  options: {
    host?: string;
    port?: number;
    cacheDir?: string;
    model?: string;
    dimensions?: number;
    timeoutMs?: number;
  } = {},
): Promise<PythonEmbeddingService> {
  const model = options.model ?? context.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  const dimensions =
    options.dimensions ?? context.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const cacheDir = options.cacheDir ?? embeddingCacheDir(context);
  await mkdir(cacheDir, { recursive: true });
  const worker = new PythonWorker({
    context,
    cacheDir,
    model,
    extraArgs: [
      '--serve-embeddings',
      '--host',
      options.host ?? '127.0.0.1',
      '--port',
      String(options.port ?? 0),
      '--dimensions',
      String(dimensions),
    ],
  });
  const readyPromise = worker.once('ready', options.timeoutMs ?? 15 * 60_000);
  let ready: Record<string, unknown>;
  try {
    await worker.start();
    ready = await readyPromise;
  } catch (error) {
    readyPromise.catch(() => {});
    await worker.terminate();
    throw error;
  }
  const url = String(ready.url);
  const actualModel = String(ready.model);
  const actualDimensions = Number(ready.dimensions);
  context.log('python.embeddings.ready', {
    url,
    model: actualModel,
    dimensions: actualDimensions,
    pid: ready.pid,
  });
  return {
    url,
    openaiBaseUrl: `${url}/v1`,
    model: actualModel,
    dimensions: actualDimensions,
    pid: worker.pid,
    close: async () => {
      try {
        await fetch(`${url}/close`, { method: 'POST' });
      } catch (error) {
        context.log('python.embeddings.close_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await worker.terminate();
    },
  };
}

interface MastraDocumentState {
  documentId: string;
  threadId: string;
  messageCount: number;
  inputTokens: number;
  timestamp: string;
}

interface MastraCorpusState {
  corpusId: string;
  resourceId: string;
  documents: MastraDocumentState[];
  messageCount: number;
  inputTokens: number;
  nativeObservationAttempted: boolean;
  nativeObservationObserved: boolean;
  forcedObservation: boolean;
  reflected: boolean;
  observationText: string;
  observationChars: number;
  observationTokens: number;
  rawRetained: Array<{
    id: string;
    text: string;
    createdAt: string;
    sourceDocumentId: string;
  }>;
  record: ObservationalMemoryRecord | null;
}

function messageText(message: MastraDBMessage): string {
  const texts: string[] = [];
  for (const part of message.content.parts) {
    if (part.type === 'text' && part.text.length > 0) texts.push(part.text);
  }
  return texts.join('\n');
}

function mastraMessageId(documentId: string, index: number): string {
  return `mb-${safeName(documentId)}-${index}`;
}

function documentTimestamp(document: Document): Date {
  const parsed = new Date(document.timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Document ${document.id} has an invalid timestamp ${JSON.stringify(document.timestamp)}`,
    );
  }
  return parsed;
}

class MastraAdapter implements MemoryAdapter {
  readonly id = 'mastra' as const;
  readonly name = 'Mastra Observational Memory';
  readonly mode = 'observational-context' as const;

  private storage: LibSQLStore | null = null;
  private memory: Memory | null = null;
  private readonly corpora = new Map<string, MastraCorpusState>();
  private ingestMs = 0;
  private ingestStartedAt = 0;
  private closed = false;
  private readonly dbPath: string;

  constructor(private readonly context: AdapterContext) {
    this.dbPath = path.join(context.workDir, 'mastra', 'mastra.db');
  }

  async ingest(corpora: Corpus[]): Promise<void> {
    if (this.closed) throw new Error('Mastra adapter is closed');
    if (this.corpora.size > 0) {
      throw new Error('Mastra adapter already ingested; create a fresh adapter per run');
    }
    this.ingestStartedAt = Date.now();
    await mkdir(path.dirname(this.dbPath), { recursive: true });
    const storage = new LibSQLStore({
      id: `memory-bench-mastra-${safeName(this.context.runId)}`,
      url: `file:${this.dbPath}`,
    });
    const model: OpenAICompatibleConfig = {
      providerId: 'openai',
      modelId: this.context.model,
      url: this.context.openaiBaseUrl,
      apiKey: GATEWAY_API_KEY,
      api: 'chat',
    };
    const memory = new Memory({
      storage,
      options: {
        semanticRecall: false,
        workingMemory: { enabled: false },
        observationalMemory: {
          scope: 'resource',
          model,
          temporalMarkers: true,
          observation: {
            messageTokens: MASTRA_OBSERVATION_MESSAGE_TOKENS,
            bufferTokens: false,
            bufferOnIdle: false,
            maxRetries: 3,
            failurePolicy: 'abort',
          },
          reflection: {
            observationTokens: MASTRA_REFLECTION_OBSERVATION_TOKENS,
            maxRetries: 3,
            failurePolicy: 'abort',
          },
        },
      },
    });
    this.storage = storage;
    this.memory = memory;
    this.context.log('mastra.init', {
      dbPath: this.dbPath,
      model: this.context.model,
      openaiBaseUrl: this.context.openaiBaseUrl,
      observationMessageTokens: MASTRA_OBSERVATION_MESSAGE_TOKENS,
      reflectionObservationTokens: MASTRA_REFLECTION_OBSERVATION_TOKENS,
      scope: 'resource',
    });

    for (const corpus of corpora) {
      await this.ingestCorpus(corpus);
    }
    this.ingestMs = Date.now() - this.ingestStartedAt;
    this.context.log('mastra.ingest.complete', {
      corpora: this.corpora.size,
      ingestMs: this.ingestMs,
    });
  }

  private async ingestCorpus(corpus: Corpus): Promise<void> {
    const memory = this.memory;
    if (!memory) throw new Error('Mastra memory was not initialized');
    const resourceId = corpus.id;
    const documents: MastraDocumentState[] = [];
    let messageCount = 0;
    let inputTokens = 0;

    for (const document of corpus.documents) {
      const threadId = `${corpus.id}:${document.id}`;
      const baseTime = documentTimestamp(document);
      const messages: MastraDBMessage[] = [];
      let documentTokens = 0;
      for (const [index, message] of document.messages.entries()) {
        documentTokens += this.context.countTokens(message.content);
        messages.push({
          id: mastraMessageId(document.id, index),
          threadId,
          resourceId,
          role: message.role,
          createdAt: new Date(baseTime.getTime() + index),
          content: {
            format: 2,
            parts: [{ type: 'text', text: message.content }],
          },
        });
      }
      await memory.createThread({
        resourceId,
        threadId,
        title: document.id,
        metadata: {
          corpusId: corpus.id,
          projectId: corpus.projectId,
          documentId: document.id,
          documentTimestamp: document.timestamp,
        },
      });
      if (messages.length > 0) {
        await this.saveInBatches(memory, messages);
      }
      documents.push({
        documentId: document.id,
        threadId,
        messageCount: messages.length,
        inputTokens: documentTokens,
        timestamp: document.timestamp,
      });
      messageCount += messages.length;
      inputTokens += documentTokens;
      this.context.log('mastra.ingest.document', {
        corpusId: corpus.id,
        documentId: document.id,
        messages: messages.length,
        tokens: documentTokens,
      });
    }

    const om = await memory.omEngine;
    if (!om) throw new Error('Mastra ObservationalMemory engine is unavailable');
    const firstThreadId = documents[0]?.threadId;
    if (!firstThreadId) {
      throw new Error(`Corpus ${corpus.id} has no documents to observe`);
    }

    // In resource scope this read covers every thread for the resource. The
    // unforced call is the real native 30k-token threshold path.
    const native = await om.observe({ threadId: firstThreadId, resourceId });
    let forced = false;
    let observed = native.observed;
    if (!observed) {
      const forcedResult = await om.observe({
        threadId: firstThreadId,
        resourceId,
        force: true,
      });
      forced = true;
      observed = forcedResult.observed;
    }
    if (!observed) {
      const pending = await om.getRecord(firstThreadId, resourceId);
      throw new Error(
        `Mastra Observer did not run for corpus ${corpus.id} even after forced observation ` +
          `(messages=${String(messageCount)}, pendingMessageTokens=${String(pending?.pendingMessageTokens ?? 'unknown')})`,
      );
    }

    const reflection = await om.reflect(firstThreadId, resourceId);
    await memory.settled();

    const observationText = (await om.getObservations(firstThreadId, resourceId)) ?? '';
    const record = await om.getRecord(firstThreadId, resourceId);
    const rawRetained = await this.readRetainedMessages(corpus, documents);

    const state: MastraCorpusState = {
      corpusId: corpus.id,
      resourceId,
      documents,
      messageCount,
      inputTokens,
      nativeObservationAttempted: true,
      nativeObservationObserved: native.observed,
      forcedObservation: forced,
      reflected: reflection.reflected,
      observationText,
      observationChars: observationText.length,
      observationTokens: observationText
        ? this.context.countTokens(observationText)
        : 0,
      rawRetained,
      record,
    };
    this.corpora.set(corpus.id, state);
    this.context.log('mastra.ingest.corpus', {
      corpusId: corpus.id,
      documents: documents.length,
      messages: messageCount,
      inputTokens,
      nativeObservationObserved: native.observed,
      forcedObservation: forced,
      reflected: reflection.reflected,
      observationChars: state.observationChars,
      observationTokens: state.observationTokens,
      rawRetained: rawRetained.length,
      observationTokenCount: record?.observationTokenCount ?? null,
      pendingMessageTokens: record?.pendingMessageTokens ?? null,
    });
  }

  private async saveInBatches(memory: Memory, messages: MastraDBMessage[]): Promise<void> {
    const batchSize = 200;
    for (let index = 0; index < messages.length; index += batchSize) {
      await memory.saveMessages({ messages: messages.slice(index, index + batchSize) });
    }
  }

  private async readRetainedMessages(
    corpus: Corpus,
    documents: MastraDocumentState[],
  ): Promise<MastraCorpusState['rawRetained']> {
    const memory = this.memory;
    if (!memory) return [];
    const seen = new Set<string>();
    const documentByThread = new Map(
      documents.map((document) => [document.threadId, document.documentId] as const),
    );
    const retained: MastraCorpusState['rawRetained'] = [];
    for (const document of documents) {
      const context = await memory.getContext({
        threadId: document.threadId,
        resourceId: corpus.id,
      });
      for (const message of context.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const text = messageText(message);
        if (!text) continue;
        retained.push({
          id: message.id,
          text: `${message.role}: ${text}`,
          createdAt: message.createdAt.toISOString(),
          sourceDocumentId:
            documentByThread.get(message.threadId ?? '') ?? document.documentId,
        });
      }
    }
    retained.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return retained;
  }

  async retrieve(query: RecallQuery, budget: number): Promise<Retrieval> {
    if (this.closed) throw new Error('Mastra adapter is closed');
    const state = this.corpora.get(query.corpusId);
    if (!state) {
      throw new Error(
        `Mastra adapter has no ingested corpus ${JSON.stringify(query.corpusId)}`,
      );
    }
    const items: MemoryItem[] = [];
    if (state.observationText) {
      items.push({
        id: `mastra-observations:${state.corpusId}`,
        text: state.observationText,
      });
    }
    for (const retained of state.rawRetained) {
      items.push({
        id: retained.id,
        text: retained.text,
        sourceIds: [retained.sourceDocumentId],
      });
    }
    this.context.log('mastra.retrieve', {
      queryId: query.id,
      corpusId: query.corpusId,
      budget,
      items: items.length,
      observationChars: state.observationChars,
      rawRetained: state.rawRetained.length,
    });
    return {
      items,
      metadata: {
        backend: 'mastra',
        corpusId: state.corpusId,
        source: 'ObservationalMemory.getObservations + getContext.unobservedMessages',
        observationItems: state.observationText ? 1 : 0,
        observationChars: state.observationChars,
        observationTokens: state.observationTokens,
        rawRetainedMessages: state.rawRetained.length,
        budget,
        forcedObservation: state.forcedObservation,
        nativeObservationObserved: state.nativeObservationObserved,
        reflected: state.reflected,
      },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.memory) await this.memory.settled();
    } finally {
      if (this.storage) await this.storage.close();
      this.memory = null;
      this.storage = null;
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      backend: 'mastra',
      implementation: 'Observational Memory',
      model: this.context.model,
      openaiBaseUrl: this.context.openaiBaseUrl,
      dbPath: this.dbPath,
      observationMessageTokens: MASTRA_OBSERVATION_MESSAGE_TOKENS,
      reflectionObservationTokens: MASTRA_REFLECTION_OBSERVATION_TOKENS,
      forcedSettling:
        'Native resource-scope observe(force=false) is attempted first; if the 30k pending-token threshold is not met, observe(force=true) calls the same Observer. Reflection is the genuine manual reflect() call, which runs the Reflector on active observations.',
      ingestMs: this.ingestMs,
      corpora: [...this.corpora.values()].map((state) => ({
        corpusId: state.corpusId,
        resourceId: state.resourceId,
        documents: state.documents.length,
        messages: state.messageCount,
        inputTokens: state.inputTokens,
        nativeObservationAttempted: state.nativeObservationAttempted,
        nativeObservationObserved: state.nativeObservationObserved,
        forcedObservation: state.forcedObservation,
        reflected: state.reflected,
        observationChars: state.observationChars,
        observationTokens: state.observationTokens,
        rawRetainedMessages: state.rawRetained.length,
        record: state.record
          ? {
              id: state.record.id,
              generationCount: state.record.generationCount,
              observationTokenCount: state.record.observationTokenCount,
              pendingMessageTokens: state.record.pendingMessageTokens,
              totalTokensObserved: state.record.totalTokensObserved,
              lastObservedAt: state.record.lastObservedAt?.toISOString() ?? null,
            }
          : null,
      })),
    };
  }
}

interface Mem0DocumentResult {
  documentId: string;
  messageCount: number;
  resultCount: number;
  events: Array<Record<string, unknown>>;
}

interface Mem0CorpusState {
  corpusId: string;
  scopeId: string | null;
  documents: number;
  messages: number;
  addEvents: number;
  lastIngestMs: number;
  lastRetrievalCount: number;
  stats: Record<string, unknown> | null;
}

class Mem0Adapter implements MemoryAdapter {
  readonly id = 'mem0' as const;
  readonly name = 'Mem0 (mem0ai OSS)';
  readonly mode = 'query-retrieval' as const;

  private worker: PythonWorker | null = null;
  private readonly corpora = new Map<string, Mem0CorpusState>();
  private ingestMs = 0;
  private closed = false;

  constructor(
    private readonly context: AdapterContext,
    private readonly restored?: { runId: string; corpora: Corpus[] },
  ) {}

  private async ensureWorker(): Promise<PythonWorker> {
    if (this.closed) throw new Error('Mem0 adapter is closed');
    if (this.worker) return this.worker;
    const mem0Dir = path.join(this.context.workDir, 'mem0');
    const cacheDir = embeddingCacheDir(this.context);
    await mkdir(mem0Dir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    const worker = new PythonWorker({
      context: this.context,
      cacheDir,
      mem0Dir,
      model: this.context.embeddingModel || DEFAULT_EMBEDDING_MODEL,
    });
    await worker.start();
    this.worker = worker;
    return worker;
  }

  private baseRequest(corpus: Corpus): Record<string, unknown> {
    return {
      workDir: path.join(this.context.workDir, 'mem0'),
      runId: this.restored?.runId ?? this.context.runId,
      corpusId: corpus.id,
      model: this.context.model,
      openaiBaseUrl: this.context.openaiBaseUrl,
      apiKey: GATEWAY_API_KEY,
      embeddingModel: this.context.embeddingModel || DEFAULT_EMBEDDING_MODEL,
      embeddingDimensions:
        this.context.embeddingDimensions || DEFAULT_EMBEDDING_DIMENSIONS,
      restoredDocuments: this.restored?.corpora.find(item => item.id === corpus.id)?.documents.map(document => ({ id: document.id, messageCount: document.messages.length })) ?? [],
    };
  }

  async ingest(corpora: Corpus[]): Promise<void> {
    if (this.closed) throw new Error('Mem0 adapter is closed');
    if (this.corpora.size > 0) {
      throw new Error('Mem0 adapter already ingested; create a fresh adapter per run');
    }
    const startedAt = Date.now();
    const worker = await this.ensureWorker();
    for (const corpus of corpora) {
      const base = this.baseRequest(corpus);
      const initialized = await worker.request<Record<string, unknown>>(
        { op: 'mem0_init', ...base },
        15 * 60_000,
      );
      const actualModel = String(initialized.embeddingModel);
      const actualDimensions = Number(initialized.embeddingDimensions);
      if (
        actualModel !== (this.context.embeddingModel || DEFAULT_EMBEDDING_MODEL) ||
        actualDimensions !==
          (this.context.embeddingDimensions || DEFAULT_EMBEDDING_DIMENSIONS)
      ) {
        throw new Error(
          `Mem0 embedding mismatch: worker uses ${actualModel}/${actualDimensions}, ` +
            `context declares ${this.context.embeddingModel}/${this.context.embeddingDimensions}`,
        );
      }
      const state: Mem0CorpusState = {
        corpusId: corpus.id,
        documents: this.restored?.corpora.find(item => item.id === corpus.id)?.documents.length ?? 0,
        messages: this.restored?.corpora.find(item => item.id === corpus.id)?.documents.reduce((sum, document) => sum + document.messages.length, 0) ?? 0,
        scopeId: String(initialized.scopeId),
        addEvents: 0,
        lastIngestMs: 0,
        lastRetrievalCount: 0,
        stats: (initialized.stats as Record<string, unknown> | undefined) ?? null,
      };
      this.corpora.set(corpus.id, state);
      this.context.log('mem0.init', {
        corpusId: corpus.id,
        scopeId: state.scopeId,
        qdrantPath: initialized.qdrantPath,
        historyDbPath: initialized.historyDbPath,
        embeddingModel: actualModel,
        embeddingDimensions: actualDimensions,
      });

      const existingIds = new Set(this.restored?.corpora.find(item => item.id === corpus.id)?.documents.map(document => document.id));
      for (const document of corpus.documents) {
        if (existingIds.has(document.id)) continue;
        const result = await worker.request<{
          documents: Mem0DocumentResult[];
          stats: Record<string, unknown>;
          elapsedMs: number;
        }>({
          op: 'mem0_ingest',
          ...base,
          documents: [
            {
              id: document.id,
              timestamp: document.timestamp,
              messages: document.messages,
            },
          ],
        });
        const documentResult = result.documents[0];
        if (!documentResult) {
          throw new Error(`Mem0 worker returned no result for ${document.id}`);
        }
        state.documents += 1;
        state.messages += documentResult.messageCount;
        state.addEvents += documentResult.resultCount;
        state.lastIngestMs = result.elapsedMs;
        state.stats = result.stats;
        this.context.log('mem0.ingest.document', {
          corpusId: corpus.id,
          documentId: document.id,
          messages: documentResult.messageCount,
          events: documentResult.resultCount,
          elapsedMs: result.elapsedMs,
        });
      }
    }
    this.ingestMs = Date.now() - startedAt;
    this.context.log('mem0.ingest.complete', {
      corpora: this.corpora.size,
      ingestMs: this.ingestMs,
    });
  }

  async retrieve(query: RecallQuery, budget: number, profile = false): Promise<Retrieval> {
    if (this.closed) throw new Error('Mem0 adapter is closed');
    const state = this.corpora.get(query.corpusId);
    if (!state) {
      throw new Error(
        `Mem0 adapter has no ingested corpus ${JSON.stringify(query.corpusId)}`,
      );
    }
    const worker = await this.ensureWorker();
    const result = await worker.request<{
      results: Array<Record<string, unknown>>;
      count: number;
      elapsedMs: number;
      stats: Record<string, unknown>;
      profile?: Record<string, unknown>;
    }>({
      op: 'mem0_retrieve',
      corpusId: query.corpusId,
      query: query.text,
      topK: MEM0_TOP_K,
      threshold: MEM0_THRESHOLD,
      profile,
    });
    const items: MemoryItem[] = [];
    for (const raw of result.results) {
      const text = typeof raw.memory === 'string' ? raw.memory : '';
      if (!text) continue;
      const metadata =
        raw.metadata && typeof raw.metadata === 'object'
          ? (raw.metadata as Record<string, unknown>)
          : undefined;
      const sourceIds = mem0SourceIds(metadata);
      items.push({
        text,
        ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
        ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
        ...(sourceIds.length > 0 ? { sourceIds } : {}),
      });
    }
    state.lastRetrievalCount = result.count;
    state.stats = result.stats;
    this.context.log('mem0.retrieve', {
      queryId: query.id,
      corpusId: query.corpusId,
      budget,
      topK: MEM0_TOP_K,
      threshold: MEM0_THRESHOLD,
      results: items.length,
      elapsedMs: result.elapsedMs,
    });
    return {
      items,
      metadata: {
        backend: 'mem0',
        corpusId: query.corpusId,
        scopeId: state.scopeId,
        source: 'mem0ai Memory.search',
        topK: MEM0_TOP_K,
        threshold: MEM0_THRESHOLD,
        resultCount: result.count,
        budget,
        elapsedMs: result.elapsedMs,
        ...(profile ? { profile: result.profile } : {}),
      },
    };
  }

  async profile(query: RecallQuery, budget: number): Promise<Retrieval> {
    return this.retrieve(query, budget, true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
    }
  }

  diagnostics(): Record<string, unknown> {
    return {
      backend: 'mem0',
      implementation: 'mem0ai OSS Memory.add(infer=true) / Memory.search',
      model: this.context.model,
      openaiBaseUrl: this.context.openaiBaseUrl,
      embeddingModel: this.context.embeddingModel,
      embeddingDimensions: this.context.embeddingDimensions,
      workerPid: this.worker?.pid ?? null,
      workerStderrTail: (this.worker?.tail ?? '').slice(-4_000),
      ingestMs: this.ingestMs,
      restoredRunId: this.restored?.runId ?? null,
      corpora: [...this.corpora.values()],
    };
  }
}

function mem0SourceIds(metadata: Record<string, unknown> | undefined): string[] {
  if (!metadata) return [];
  const sourceIds: string[] = [];
  const documentId = metadata.document_id;
  if (typeof documentId === 'string' && documentId) sourceIds.push(documentId);
  if (Array.isArray(documentId)) {
    for (const value of documentId) {
      if (typeof value === 'string' && value) sourceIds.push(value);
    }
  }
  const documentIds = metadata.document_ids;
  if (Array.isArray(documentIds)) {
    for (const value of documentIds) {
      if (typeof value === 'string' && value) sourceIds.push(value);
    }
  }
  return [...new Set(sourceIds)];
}

export const createMastraAdapter: AdapterFactory = async (context) => {
  return new MastraAdapter(context);
};

export async function createMem0Adapter(
  context: AdapterContext,
  restored?: { runId: string; corpora: Corpus[] },
): Promise<MemoryAdapter> {
  return new Mem0Adapter(context, restored);
}


