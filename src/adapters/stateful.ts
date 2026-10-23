import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { RecallResult } from "@oh-my-pi/pi-mnemopi";
import type { MemoryFacadeStats } from "@oh-my-pi/pi-mnemopi/core/memory";
import { getExtractionStats } from "@oh-my-pi/pi-mnemopi/core/extraction/diagnostics";
import type { ExtractionStatsSnapshot } from "@oh-my-pi/pi-mnemopi/core/extraction/diagnostics";
import { getHindsightService } from "../hindsight-service";
import type { HindsightService, HindsightServiceDiagnostics, HindsightServiceOptions } from "../hindsight-service";
import type {
	AdapterContext,
	AdapterFactory,
	Corpus,
	Document,
	MemoryItem,
	RecallQuery,
	Retrieval,
} from "../types";

const MNEMOPI_ENGINE_VERSION = "18.11.0";
const MNEMOPI_RECALL_TOP_K = 8;
const MNEMOPI_EXTRACTION_FLUSH_EVERY = 4;
const MNEMOPI_COMPLETION_MAX_TOKENS = 2048;
const EMBEDDING_REQUEST_TIMEOUT_MS = 120_000;

interface MnemopiStore {
	corpusId: string;
	bank: string;
	dbPath: string;
	memory: Mnemopi;
	stats: MemoryFacadeStats | null;
	storageBytes: number | null;
	workingCount: number;
	embeddingCount: number;
	factsCount: number;
	extraction: Record<string, number> | null;
	lastEmbeddingError: string | null;
	completionCalls: number;
	completionErrors: number;
	lastCompletionError: string | null;
}

interface MnemopiProviderState {
	lastEmbeddingError: string | null;
	embeddingRequests: number;
	embeddingVectors: number;
}

interface MnemopiDiagnostics {
	[key: string]: unknown;
	backend: "mnemopi";
	engine: "@oh-my-pi/pi-mnemopi";
	engineVersion: string;
	recallMode: "recallEnhanced";
	recallOptions: {
		includeFacts: true;
		contentPreviewChars: 0;
		channelScoped: true;
		queryTimeFromAsOf: true;
	};
	recallTopK: number;
	extraction: {
		completionMaxTokens: number;
		completionCalls: number;
		completionErrors: number;
		lastCompletionError: string | null;
		engineStats: ExtractionStatsSnapshot | null;
	};
	embeddings: {
		model: string;
		dimensions: number;
		baseUrl: string;
		authHeader: "env:MEMORY_BENCH_GATEWAY_API_KEY" | "none";
		requests: number;
		vectors: number;
		lastError: string | null;
	};
	stores: Array<{
		corpusId: string;
		bank: string;
		dbPath: string;
		storageBytes: number | null;
		workingCount: number;
		embeddingCount: number;
		factsCount: number;
		stats: MemoryFacadeStats | null;
		extraction: Record<string, number> | null;
		completionCalls: number;
		completionErrors: number;
		lastCompletionError: string | null;
		lastEmbeddingError: string | null;
	}>;
	errors: Array<{ at: string; operation: string; message: string }>;
}

const RETENTION_MARKER = /^\[(?:role:\s*[-_a-zA-Z0-9]+|[-_a-zA-Z0-9]+:end|timestamp:\s+.+)\]$/;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function countFromRow(row: unknown): number {
	if (row !== null && typeof row === "object" && "count" in row) {
		const count = row.count;
		if (typeof count === "number" && Number.isFinite(count)) return count;
	}
	throw new Error(`SQLite count query returned an unexpected row: ${JSON.stringify(row)}`);
}

/** Validate the embedding boundary once; callers only see a checked matrix. */
function parseEmbeddingResponse(raw: string, expectedCount: number, dimensions: number): number[][] {
	const payload: unknown = JSON.parse(raw);
	if (payload === null || typeof payload !== "object" || !("data" in payload)) {
		throw new Error("embedding endpoint response has no data array");
	}
	const data: unknown = payload.data;
	if (!Array.isArray(data) || data.length !== expectedCount) {
		throw new Error(
			`embedding endpoint returned ${Array.isArray(data) ? data.length : "no"} vectors for ${expectedCount} inputs`,
		);
	}
	const dataItems: unknown[] = data;
	const rows: Array<{ index: number; embedding: unknown }> = [];
	for (let fallbackIndex = 0; fallbackIndex < dataItems.length; fallbackIndex += 1) {
		const row = dataItems[fallbackIndex];
		if (row === null || typeof row !== "object") {
			throw new Error(`embedding endpoint returned a non-object row at index ${fallbackIndex}`);
		}
		let index = fallbackIndex;
		if ("index" in row && typeof row.index === "number" && Number.isInteger(row.index)) {
			index = row.index;
		}
		if (!("embedding" in row)) {
			throw new Error(`embedding endpoint row ${fallbackIndex} has no embedding`);
		}
		rows.push({ index, embedding: row.embedding });
	}
	rows.sort((left, right) => left.index - right.index);
	const matrix: number[][] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const embedding = rows[index]?.embedding;
		if (!Array.isArray(embedding) || embedding.length === 0) {
			throw new Error(`embedding endpoint returned an empty vector at index ${index}`);
		}
		const embeddingValues: unknown[] = embedding;
		const values: number[] = [];
		for (const value of embeddingValues) {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				throw new Error(`embedding endpoint returned a non-finite value at index ${index}`);
			}
			values.push(value);
		}
		if (dimensions > 0 && values.length !== dimensions) {
			throw new Error(
				`embedding dimension mismatch at index ${index}: expected ${dimensions}, got ${values.length}`,
			);
		}
		matrix.push(values);
	}
	return matrix;
}

/** Preserve the coding-agent's transcript framing: markers for retention/extraction, plain text for embeddings. */
function formatMnemopiTranscript(messages: Document["messages"], mode: "retention" | "embed" | "users"): string | null {
	const parts: string[] = [];
	for (const message of messages) {
		if (mode === "users" && message.role !== "user") continue;
		const content = message.content.trim();
		if (content === "" || !/[\p{L}\p{N}]/u.test(content)) continue;
		parts.push(
			mode === "embed" ? content : `[role: ${message.role}]\n${content}\n[${message.role}:end]`,
		);
	}
	if (parts.length === 0) return null;
	const transcript = parts.join("\n\n");
	return transcript.trim().length < 10 ? null : transcript;
}

/** Remove retention framing before exposing memory text to the reader. */
function cleanMnemopiContent(content: string): string {
	return content
		.split(/\r?\n/)
		.filter(line => !RETENTION_MARKER.test(line.trim()))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function recallDocumentId(result: RecallResult): string | null {
	let metadata: unknown = result.metadata;
	if (metadata === undefined && typeof result.metadata_json === "string" && result.metadata_json !== "") {
		try {
			metadata = JSON.parse(result.metadata_json);
		} catch {
			return null;
		}
	}
	if (metadata === null || typeof metadata !== "object" || !("document_id" in metadata)) return null;
	return typeof metadata.document_id === "string" && metadata.document_id !== "" ? metadata.document_id : null;
}

function truncateToTokenBudget(
	text: string,
	maxTokens: number,
	countTokens: (text: string) => number,
): string {
	if (maxTokens <= 0 || text === "") return "";
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (countTokens(text.slice(0, mid)) <= maxTokens) low = mid;
		else high = mid - 1;
	}
	return low <= 0 ? "" : text.slice(0, low).trimEnd();
}

function packMnemopiResults(
	results: readonly RecallResult[],
	budget: number,
	countTokens: (text: string) => number,
): { items: MemoryItem[]; context: string; contextTokens: number; truncated: boolean; skipped: number } {
	const items: MemoryItem[] = [];
	const texts: string[] = [];
	let used = 0;
	let truncated = false;
	for (const result of results) {
		const text = cleanMnemopiContent(result.content);
		if (text === "") continue;
		const cost = countTokens(text);
		if (used + cost <= budget) {
			const documentId = recallDocumentId(result);
			const item: MemoryItem = { id: result.id, text };
			if (typeof result.score === "number") item.score = result.score;
			if (documentId !== null) item.sourceIds = [documentId];
			items.push(item);
			texts.push(text);
			used += cost;
			continue;
		}
		if (items.length === 0) {
			const partial = truncateToTokenBudget(text, Math.max(0, budget), countTokens);
			if (partial !== "") {
				const documentId = recallDocumentId(result);
				const item: MemoryItem = { id: result.id, text: partial };
				if (typeof result.score === "number") item.score = result.score;
				if (documentId !== null) item.sourceIds = [documentId];
				items.push(item);
				texts.push(partial);
				truncated = true;
			}
		}
		break;
	}
	let context = texts.join("\n\n");
	let contextTokens = countTokens(context);
	// Separators are part of the rendered context; drop trailing items until the
	// measured context (not just the sum of item texts) fits the budget.
	while (items.length > 1 && contextTokens > budget) {
		items.pop();
		texts.pop();
		context = texts.join("\n\n");
		contextTokens = countTokens(context);
		truncated = true;
	}
	return {
		items,
		context,
		contextTokens,
		truncated,
		skipped: results.length - items.length,
	};
}

function extractionDelta(
	before: ExtractionStatsSnapshot,
	after: ExtractionStatsSnapshot,
): Record<string, number> {
	const delta: Record<string, number> = {
		calls: after.totals.calls - before.totals.calls,
		successes: after.totals.successes - before.totals.successes,
		failures: after.totals.failures - before.totals.failures,
		empty: after.totals.empty - before.totals.empty,
		host_attempts: after.by_tier.host.attempts - before.by_tier.host.attempts,
		host_successes: after.by_tier.host.successes - before.by_tier.host.successes,
		host_no_output: after.by_tier.host.no_output - before.by_tier.host.no_output,
		host_failures: after.by_tier.host.failures - before.by_tier.host.failures,
		local_successes: after.by_tier.local.successes - before.by_tier.local.successes,
		remote_successes: after.by_tier.remote.successes - before.by_tier.remote.successes,
	};
	for (const key of Object.keys(delta)) {
		if (delta[key] === undefined) delta[key] = 0;
	}
	return delta;
}

function mnemopiStoreDiagnostics(store: MnemopiStore): MnemopiDiagnostics["stores"][number] {
	return {
		corpusId: store.corpusId,
		bank: store.bank,
		dbPath: store.dbPath,
		storageBytes: store.storageBytes,
		workingCount: store.workingCount,
		embeddingCount: store.embeddingCount,
		factsCount: store.factsCount,
		stats: store.stats,
		extraction: store.extraction,
		completionCalls: store.completionCalls,
		completionErrors: store.completionErrors,
		lastCompletionError: store.lastCompletionError,
		lastEmbeddingError: store.lastEmbeddingError,
	};
}

function mnemopiDatabasePath(context: AdapterContext, corpus: Corpus): string {
	const digest = createHash("sha256").update(`${corpus.projectId}\0${corpus.id}`).digest("hex").slice(0, 10);
	const readable = corpus.id
		.replace(/[^A-Za-z0-9_.-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return resolve(context.workDir, "mnemopi", `${readable === "" ? "corpus" : readable}-${digest}.db`);
}

function gatewayAuthHeader(): { value: string | null; source: "env:MEMORY_BENCH_GATEWAY_API_KEY" | "none" } {
	const value = process.env.MEMORY_BENCH_GATEWAY_API_KEY?.trim();
	return value !== undefined && value !== ""
		? { value, source: "env:MEMORY_BENCH_GATEWAY_API_KEY" }
		: { value: null, source: "none" };
}

export const createMnemopiAdapter: AdapterFactory = async (context: AdapterContext) => {
	const stores = new Map<string, MnemopiStore>();
	const closedStores: MnemopiDiagnostics["stores"] = [];
	const errors: MnemopiDiagnostics["errors"] = [];
	const providerState: MnemopiProviderState = {
		lastEmbeddingError: null,
		embeddingRequests: 0,
		embeddingVectors: 0,
	};
	const auth = gatewayAuthHeader();
	let activeStore: MnemopiStore | null = null;

	const embeddingProvider = {
		async *embed(texts: readonly string[]): AsyncGenerator<number[][]> {
			if (texts.length === 0) return;
			providerState.embeddingRequests += 1;
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (auth.value !== null) headers.Authorization = `Bearer ${auth.value}`;
			const body: Record<string, unknown> = {
				model: context.embeddingModel,
				input: [...texts],
			};
			if (context.embeddingDimensions > 0) body.dimensions = context.embeddingDimensions;
			try {
				const response = await fetch(
					`${context.openaiBaseUrl.replace(/\/+$/, "")}/embeddings`,
					{
						method: "POST",
						headers,
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
					},
				);
				const raw = await response.text();
				if (!response.ok) {
					throw new Error(
						`embedding endpoint returned HTTP ${response.status} ${response.statusText}: ${raw.slice(0, 4000)}`,
					);
				}
				const matrix = parseEmbeddingResponse(raw, texts.length, context.embeddingDimensions);
				providerState.embeddingVectors += matrix.length;
				yield matrix;
			} catch (error) {
				providerState.lastEmbeddingError = errorMessage(error);
				throw error;
			}
		},
		async available(): Promise<boolean> {
			return true;
		},
	};

	const complete = async (
		prompt: string,
		options?: { maxTokens?: number },
	): Promise<string> => {
		const store = activeStore;
		if (store !== null) store.completionCalls += 1;
		try {
			return await context.complete("", prompt, {
				maxTokens: options?.maxTokens ?? MNEMOPI_COMPLETION_MAX_TOKENS,
				json: true,
			});
		} catch (error) {
			if (store !== null) {
				store.completionErrors += 1;
				store.lastCompletionError = errorMessage(error);
			}
			throw error;
		}
	};

	const ingestCorpus = async (corpus: Corpus): Promise<MnemopiStore> => {
		const existing = stores.get(corpus.id);
		if (existing !== undefined) {
			await existing.memory.flushExtractions();
			existing.memory.close();
			stores.delete(corpus.id);
		}
		const dbPath = mnemopiDatabasePath(context, corpus);
		await mkdir(resolve(context.workDir, "mnemopi"), { recursive: true, mode: 0o700 });
		await rm(dbPath, { force: true });
		await rm(`${dbPath}-wal`, { force: true });
		await rm(`${dbPath}-shm`, { force: true });

		const bank = corpus.id;
		const before = getExtractionStats();
		const memory = new Mnemopi({
			dbPath,
			bank,
			sessionId: bank,
			authorId: "memory-bench",
			authorType: "benchmark",
			channelId: bank,
			noEmbeddings: false,
			embeddings: {
				disabled: false,
				model: context.embeddingModel,
				apiUrl: context.openaiBaseUrl,
				apiKey: "",
				provider: embeddingProvider,
			},
			llm: {
				enabled: true,
				complete,
				maxTokens: MNEMOPI_COMPLETION_MAX_TOKENS,
			},
			reconcile: true,
		});

		const store: MnemopiStore = {
			corpusId: corpus.id,
			bank,
			dbPath,
			memory,
			stats: null,
			storageBytes: null,
			workingCount: 0,
			embeddingCount: 0,
			factsCount: 0,
			extraction: null,
			lastEmbeddingError: null,
			completionCalls: 0,
			completionErrors: 0,
			lastCompletionError: null,
		};
		stores.set(corpus.id, store);
		activeStore = store;

		let retained = 0;
		let skipped = 0;
		for (const document of corpus.documents) {
			const transcript = formatMnemopiTranscript(document.messages, "retention");
			if (transcript === null) {
				skipped += 1;
				continue;
			}
			const embedText = formatMnemopiTranscript(document.messages, "embed") ?? transcript;
			const extractText = formatMnemopiTranscript(document.messages, "users");
			memory.remember(transcript, {
				source: document.id,
				timestamp: document.timestamp,
				importance: 0.5,
				metadata: {
					corpus_id: corpus.id,
					project_id: corpus.projectId,
					document_id: document.id,
				},
				scope: "bank",
				extract: extractText !== null,
				extractEntities: extractText !== null,
				extractText,
				embedText,
				veracity: "unknown",
				memoryType: "episode",
				// Imported corpus rows remain durable regardless of their historical timestamps.
				trustTier: "IMPORTED",
			});
			retained += 1;
			if (retained % MNEMOPI_EXTRACTION_FLUSH_EVERY === 0) {
				await memory.flushExtractions();
			}
		}
		await memory.flushExtractions();

		const workingCount = countFromRow(
			memory.db.query("SELECT COUNT(*) AS count FROM working_memory WHERE superseded_by IS NULL").get(),
		);
		const embeddingCount = countFromRow(
			memory.db
				.query(
					"SELECT COUNT(*) AS count FROM working_memory w JOIN memory_embeddings e ON e.memory_id = w.id WHERE w.superseded_by IS NULL",
				)
				.get(),
		);
		const factsCount = countFromRow(memory.db.query("SELECT COUNT(*) AS count FROM facts").get());
		const after = getExtractionStats();
		store.stats = memory.getStats();
		store.workingCount = workingCount;
		store.embeddingCount = embeddingCount;
		store.factsCount = factsCount;
		store.extraction = extractionDelta(before, after);
		store.lastEmbeddingError = providerState.lastEmbeddingError;
		store.storageBytes = await stat(dbPath)
			.then(value => value.size)
			.catch(() => null);

		if (workingCount > 0 && embeddingCount < workingCount) {
			throw new Error(
				`Mnemopi embedding coverage is incomplete for corpus ${corpus.id}: ${embeddingCount}/${workingCount} memories have vectors. ` +
					`The engine swallows background embedding errors; last provider error: ${providerState.lastEmbeddingError ?? "none recorded"}`,
			);
		}
		const hostFailures = store.extraction?.host_failures ?? 0;
		if (hostFailures > 0) {
			throw new Error(
				`Mnemopi GPT extraction failed ${hostFailures} time(s) for corpus ${corpus.id}: ${store.lastCompletionError ?? "no error captured"}`,
			);
		}

		context.log("mnemopi.ingest.complete", {
			corpusId: corpus.id,
			bank,
			dbPath,
			documents: corpus.documents.length,
			retained,
			skipped,
			workingCount,
			embeddingCount,
			factsCount,
			extraction: store.extraction,
			storageBytes: store.storageBytes,
		});
		return store;
	};

	const ingest = async (corpora: Corpus[]): Promise<void> => {
		const started = Date.now();
		try {
			for (const corpus of corpora) {
				await ingestCorpus(corpus);
			}
		} catch (error) {
			errors.push({ at: new Date().toISOString(), operation: "ingest", message: errorMessage(error) });
			throw error;
		}
		context.log("mnemopi.ingest.done", {
			corpora: corpora.length,
			stores: stores.size,
			elapsedMs: Date.now() - started,
		});
	};

	const retrieve = async (query: RecallQuery, budget: number): Promise<Retrieval> => {
		const store = stores.get(query.corpusId);
		if (store === undefined) {
			const error = new Error(`Mnemopi has no ingested store for corpus ${query.corpusId}`);
			errors.push({ at: new Date().toISOString(), operation: `retrieve:${query.id}`, message: error.message });
			throw error;
		}
		const started = Date.now();
		let results: RecallResult[];
		try {
			results = await store.memory.recallEnhanced(query.text, MNEMOPI_RECALL_TOP_K, {
				includeFacts: true,
				channelId: store.bank,
			});
		} catch (error) {
			errors.push({ at: new Date().toISOString(), operation: `retrieve:${query.id}`, message: errorMessage(error) });
			throw error;
		}
		const packed = packMnemopiResults(results, budget, context.countTokens);
		const latencyMs = Date.now() - started;
		const factResults = results.filter(result => result.tier_label === "fact" || result.tier === "fact");
		context.log("mnemopi.recall", {
			corpusId: query.corpusId,
			queryId: query.id,
			budget,
			requestedTopK: MNEMOPI_RECALL_TOP_K,
			returned: results.length,
			factsReturned: factResults.length,
			selected: packed.items.length,
			contextTokens: packed.contextTokens,
			truncated: packed.truncated,
			latencyMs,
		});
		return {
			items: packed.items,
			metadata: {
				backend: "mnemopi",
				engine: "@oh-my-pi/pi-mnemopi",
				engineVersion: MNEMOPI_ENGINE_VERSION,
				bank: store.bank,
				dbPath: store.dbPath,
				mode: "recallEnhanced",
				options: {
					includeFacts: true,
					channelId: store.bank,
					topK: MNEMOPI_RECALL_TOP_K,
				},
				budget,
				returned: results.length,
				factsReturned: factResults.length,
				selected: packed.items.length,
				skippedForBudget: packed.skipped,
				truncated: packed.truncated,
				contextTokens: packed.contextTokens,
				latencyMs,
				embeddingCoverage: {
					memories: store.workingCount,
					vectors: store.embeddingCount,
				},
			},
		};
	};

	const close = async (): Promise<void> => {
		activeStore = null;
		for (const store of stores.values()) {
			try {
				await store.memory.flushExtractions();
			} catch (error) {
				context.log("mnemopi.close.flush-failed", {
					corpusId: store.corpusId,
					error: errorMessage(error),
				});
			}
			store.memory.close();
			closedStores.push(mnemopiStoreDiagnostics(store));
		}
		stores.clear();
	};

	const diagnostics = (): Record<string, unknown> => {
		const allStores = [...closedStores, ...[...stores.values()].map(mnemopiStoreDiagnostics)];
		const diag: MnemopiDiagnostics = {
			backend: "mnemopi",
			engine: "@oh-my-pi/pi-mnemopi",
			engineVersion: MNEMOPI_ENGINE_VERSION,
			recallMode: "recallEnhanced",
			recallOptions: {
				includeFacts: true,
				contentPreviewChars: 0,
				channelScoped: true,
				queryTimeFromAsOf: true,
			},
			recallTopK: MNEMOPI_RECALL_TOP_K,
			extraction: {
				completionMaxTokens: MNEMOPI_COMPLETION_MAX_TOKENS,
				completionCalls: allStores.reduce((sum, store) => sum + store.completionCalls, 0),
				completionErrors: allStores.reduce((sum, store) => sum + store.completionErrors, 0),
				lastCompletionError:
					allStores.map(store => store.lastCompletionError).filter(value => value !== null).at(-1) ?? null,
				engineStats: getExtractionStats(),
			},
			embeddings: {
				model: context.embeddingModel,
				dimensions: context.embeddingDimensions,
				baseUrl: context.openaiBaseUrl,
				authHeader: auth.source,
				requests: providerState.embeddingRequests,
				vectors: providerState.embeddingVectors,
				lastError: providerState.lastEmbeddingError,
			},
			stores: allStores,
			errors: errors.map(error => ({ ...error })),
		};
		return diag;
	};

	return {
		id: "mnemopi",
		name: "Mnemopi (SQLite, GPT extraction)",
		mode: "query-retrieval",
		ingest,
		retrieve,
		close,
		diagnostics,
	};
};

export async function createHindsightAdapter(
	context: AdapterContext,
	options: HindsightServiceOptions = {},
	restoredCorpora?: Corpus[],
) {
	const service: HindsightService = getHindsightService(context, options);
	const errors: Array<{ at: string; operation: string; message: string }> = [];

	const ingest = async (corpora: Corpus[]): Promise<void> => {
		for (const corpus of corpora) {
			try {
				const restored = restoredCorpora?.find(item => item.id === corpus.id);
				const existingIds = new Set(restored?.documents.map(document => document.id));
				await service.ingestCorpus(
					{ ...corpus, documents: corpus.documents.filter(document => !existingIds.has(document.id)) },
					restored !== undefined,
				);
			} catch (error) {
				errors.push({ at: new Date().toISOString(), operation: `ingest:${corpus.id}`, message: errorMessage(error) });
				context.log("hindsight.ingest.failed", {
					corpusId: corpus.id,
					error: errorMessage(error),
				});
				throw error;
			}
		}
	};

	const retrieve = async (query: RecallQuery, budget: number): Promise<Retrieval> => {
		try {
			return await service.retrieve(query.corpusId, query, budget);
		} catch (error) {
			errors.push({ at: new Date().toISOString(), operation: `retrieve:${query.id}`, message: errorMessage(error) });
			throw error;
		}
	};

	return {
		id: "hindsight" as const,
		name: "Hindsight 0.9.2 (local Docker)",
		mode: "query-retrieval" as const,
		ingest,
		retrieve,
		profile: (query: RecallQuery, budget: number) => service.retrieve(query.corpusId, query, budget, true),
		close: async () => {
			await service.close();
		},
		diagnostics: () => {
			const diagnostics: HindsightServiceDiagnostics = service.diagnostics();
			return { ...diagnostics, adapterErrors: errors.map(error => ({ ...error })) };
		},
	};
}
