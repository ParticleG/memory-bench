import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
	AdapterContext,
	Corpus,
	Document,
	MemoryItem,
	RecallQuery,
	Retrieval,
} from "./types";

const execFileAsync = promisify(execFile);

/** Pinned image; the user's live `omp-hindsight` container on port 8888 is never touched. */
export const HINDSIGHT_IMAGE = "ghcr.io/vectorize-io/hindsight:0.9.2";
export const HINDSIGHT_CONTAINER_PORT = 8891;
export const HINDSIGHT_RERANKER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2";
const HINDSIGHT_STARTUP_TIMEOUT_MS = 300_000;
const HINDSIGHT_RETAIN_TIMEOUT_MS = 900_000;
const HINDSIGHT_RECALL_TIMEOUT_MS = 180_000;
const HINDSIGHT_CONSOLIDATION_TIMEOUT_MS = 1_800_000;
const HINDSIGHT_INGEST_BATCH_SIZE = 8;
const DOCKER_COMMAND_TIMEOUT_MS = 120_000;
const ERROR_BODY_LIMIT = 4_000;

type FetchLike = typeof fetch;

export type HindsightBudgetLevel = "low" | "mid" | "high";


export interface HindsightServiceOptions {
	port?: number;
	image?: string;
	dataDir?: string;
	fetch?: FetchLike;
	consolidationTimeoutMs?: number;
	workerId?: string;
	budgetLevel?: HindsightBudgetLevel;
	reranking?: boolean;
	rerankerModel?: string;
	bucketBatching?: boolean;
}

export interface HindsightProvision {
	baseUrl: string;
	containerName: string;
	containerId: string;
	image: string;
	imageId: string | null;
	dataDir: string;
	networkMode: string;
	bindAddress: string;
}

export interface HindsightIngestResult {
	corpusId: string;
	bankId: string;
	documents: number;
	retainedItems: number;
	skippedDocuments: number;
	consolidationOperationId: string | null;
	consolidationMs: number;
	restoredDocuments?: number;
	stats: HindsightBankStats;
	usage: HindsightTokenUsage | null;
}

export interface HindsightTokenUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

export interface HindsightBankStats {
	bank_id: string;
	total_nodes: number;
	total_links: number;
	total_documents: number;
	nodes_by_fact_type: Record<string, number>;
	pending_operations: number;
	failed_operations: number;
	pending_consolidation: number;
	failed_consolidation: number;
	total_observations: number;
	last_consolidated_at?: string | null;
}

interface HindsightRecallResult {
	id: string;
	text: string;
	type?: string | null;
	document_id?: string | null;
	source_fact_ids?: string[] | null;
	mentioned_at?: string | null;
	scores?: {
		final?: number;
		reranker?: number | null;
		semantic?: number | null;
		keyword?: number | null;
	} | null;
}

interface HindsightRecallResponse {
	results: HindsightRecallResult[];
	trace?: Record<string, unknown> | null;
}

interface HindsightOperationStatus {
	operation_id: string;
	status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "not_found";
	error_message?: string | null;
	result_metadata?: Record<string, unknown> | null;
}

interface HindsightRetainResponse {
	success: boolean;
	bank_id: string;
	items_count: number;
	async?: boolean;
	usage?: HindsightTokenUsage | null;
}

interface HindsightConsolidationResponse {
	operation_id: string;
	deduplicated?: boolean;
}

interface HindsightBankProfile {
	bank_id: string;
	name: string;
	mission: string;
}

interface DockerContainerState {
	Status?: string;
	Running?: boolean;
	ExitCode?: number;
	Error?: string;
}

interface DockerContainer {
	Id: string;
	Name: string;
	State: DockerContainerState;
	Config?: { Image?: string; Labels?: Record<string, string> | null };
	HostConfig?: { NetworkMode?: string };
}

export interface HindsightServiceDiagnostics {
	engine: "hindsight";
	image: string;
	imageId: string | null;
	containerName: string;
	containerId: string | null;
	baseUrl: string;
	networkMode: string | null;
	bindAddress: string;
	dataDir: string;
	llm: {
		provider: "openai";
		model: string;
		baseUrl: string;
		apiKeySource: "env:MEMORY_BENCH_GATEWAY_API_KEY" | "loopback-placeholder";
	};
	embeddings: {
		provider: "openai";
		model: string;
		dimensions: number | null;
		baseUrl: string;
	};
	reranker: {
		provider: "local";
		model: string;
		forceCpu: true;
		enabled: boolean;
		bucketBatching: boolean;
		note: string;
	};
	bankConfig: {
		perBankLlmConfigSupported: false;
		providerSelection: "server-environment-only";
	};
	ingests: HindsightIngestResult[];
	recalls: Array<{
		corpusId: string;
		queryId: string;
		budget: number;
		budgetLevel: HindsightBudgetLevel;
		maxTokens: number;
		results: number;
		latencyMs: number;
	}>;
	errors: Array<{ at: string; operation: string; message: string }>;
}

interface JsonRequestOptions {
	timeoutMs?: number;
	allowStatus?: readonly number[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function gatewayApiKey(): { value: string; source: HindsightServiceDiagnostics["llm"]["apiKeySource"] } {
	const fromEnv = process.env.MEMORY_BENCH_GATEWAY_API_KEY?.trim();
	if (fromEnv !== undefined && fromEnv !== "") {
		return { value: fromEnv, source: "env:MEMORY_BENCH_GATEWAY_API_KEY" };
	}
	// Hindsight's OpenAI provider rejects an empty key. The loopback gateway is
	// expected to authenticate upstream itself; this placeholder is not a credential.
	return { value: "memory-bench-loopback", source: "loopback-placeholder" };
}

/** Validate the documented `docker inspect` array shape instead of asserting it. */
function parseDockerInspect(raw: string): DockerContainer | null {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed)) throw new Error("docker inspect returned a non-array response");
	const first: unknown = parsed[0];
	if (first === undefined) return null;
	if (first === null || typeof first !== "object" || !("Id" in first) || typeof first.Id !== "string") {
		throw new Error("docker inspect returned a container without a string Id");
	}
	const container: DockerContainer = { Id: first.Id, Name: "", State: {} };
	if ("Name" in first && typeof first.Name === "string") container.Name = first.Name;
	if ("State" in first && first.State !== null && typeof first.State === "object") {
		const state = first.State;
		if ("Status" in state && typeof state.Status === "string") container.State.Status = state.Status;
		if ("Running" in state && typeof state.Running === "boolean") container.State.Running = state.Running;
		if ("ExitCode" in state && typeof state.ExitCode === "number") container.State.ExitCode = state.ExitCode;
		if ("Error" in state && typeof state.Error === "string") container.State.Error = state.Error;
	}
	if ("Config" in first && first.Config !== null && typeof first.Config === "object") {
		const config: NonNullable<DockerContainer["Config"]> = {};
		if ("Image" in first.Config && typeof first.Config.Image === "string") config.Image = first.Config.Image;
		if (
			"Labels" in first.Config &&
			first.Config.Labels !== null &&
			typeof first.Config.Labels === "object" &&
			!Array.isArray(first.Config.Labels)
		) {
			const labels: Record<string, string> = {};
			for (const [key, value] of Object.entries(first.Config.Labels)) {
				if (typeof value === "string") labels[key] = value;
			}
			config.Labels = labels;
		}
		container.Config = config;
	}
	if (
		"HostConfig" in first &&
		first.HostConfig !== null &&
		typeof first.HostConfig === "object" &&
		"NetworkMode" in first.HostConfig &&
		typeof first.HostConfig.NetworkMode === "string"
	) {
		container.HostConfig = { NetworkMode: first.HostConfig.NetworkMode };
	}
	return container;
}

function safeBankId(corpus: Corpus): string {
	const digest = createHash("sha256").update(`${corpus.projectId}\0${corpus.id}`).digest("hex").slice(0, 10);
	const readable = corpus.id
		.replace(/[^A-Za-z0-9_.-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 80);
	return `mb-${readable === "" ? "corpus" : readable}-${digest}`;
}

/** Formats a corpus document exactly as the omp Hindsight integration frames retained transcripts. */
export function formatHindsightDocument(document: Document): string {
	const parts: string[] = [];
	for (const message of document.messages) {
		const content = message.content.trim();
		if (content === "") continue;
		parts.push(`[role: ${message.role}]\n${content}\n[${message.role}:end]`);
	}
	return parts.join("\n\n");
}

function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (value === undefined || value === null || value === "") continue;
		if (seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export class HindsightService {
	readonly #context: AdapterContext;
	readonly #port: number;
	readonly #image: string;
	readonly #dataDir: string;
	readonly #fetch: FetchLike;
	readonly #consolidationTimeoutMs: number;
	readonly #containerName: string;
	readonly #gatewayKey = gatewayApiKey();

	#provision: HindsightProvision | null = null;
	#startPromise: Promise<HindsightProvision> | null = null;
	#closePromise: Promise<void> | null = null;
	#imageId: string | null = null;
	#bankIds = new Map<string, string>();
	#ingests: HindsightIngestResult[] = [];
	#recalls: HindsightServiceDiagnostics["recalls"] = [];
	#errors: HindsightServiceDiagnostics["errors"] = [];
	#options: HindsightServiceOptions;

	constructor(context: AdapterContext, options: HindsightServiceOptions = {}) {
		this.#context = context;
		this.#options = options;
		const envPort = Number.parseInt(process.env.MEMORY_BENCH_HINDSIGHT_PORT ?? "", 10);
		const validEnvPort = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : null;
		this.#port = options.port ?? validEnvPort ?? HINDSIGHT_CONTAINER_PORT;
		this.#image = options.image ?? HINDSIGHT_IMAGE;
		this.#dataDir = options.dataDir === undefined ? resolve(context.workDir, "hindsight", "pg0") : resolve(options.dataDir);
		this.#fetch = options.fetch ?? fetch;
		this.#consolidationTimeoutMs = options.consolidationTimeoutMs ?? HINDSIGHT_CONSOLIDATION_TIMEOUT_MS;
		const scope = createHash("sha256")
			.update(`${context.workDir}\0${context.runId}\0${this.#port}`)
			.digest("hex")
			.slice(0, 12);
		this.#containerName = `memory-bench-hindsight-${scope}`;
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.#port}`;
	}

	get containerName(): string {
		return this.#containerName;
	}

	get dataDir(): string {
		return this.#dataDir;
	}

	async start(): Promise<HindsightProvision> {
		if (this.#provision !== null) return this.#provision;
		if (this.#startPromise === null) {
			this.#startPromise = this.#startInternal().catch(error => {
				this.#startPromise = null;
				this.#recordError("start", error);
				throw error;
			});
		}
		return await this.#startPromise;
	}

	async close(): Promise<void> {
		if (this.#closePromise !== null) return await this.#closePromise;
		this.#closePromise = this.#closeInternal().finally(() => {
			this.#closePromise = null;
		});
		return await this.#closePromise;
	}

	async ingestCorpus(corpus: Corpus, reuse = false): Promise<HindsightIngestResult> {
		const provision = await this.start();
		const bankId = this.#bankIds.get(corpus.id) ?? safeBankId(corpus);
		this.#bankIds.set(corpus.id, bankId);
		this.#context.log("hindsight.ingest.start", {
			corpusId: corpus.id,
			bankId,
			documents: corpus.documents.length,
			baseUrl: provision.baseUrl,
		});

		// Only a copied benchmark store may be reopened; fresh runs still replace their own banks.
		const restoredStats = reuse ? await this.getBankStats(bankId) : undefined;
		const restoredDocuments = restoredStats?.total_documents ?? 0;
		if (!reuse) {
			await this.#deleteBank(bankId);
			await this.#createBank(bankId);
		}

		let retainedItems = 0;
		let skippedDocuments = 0;
		let usage: HindsightTokenUsage | null = null;

		const documents: Array<{ document: Document; content: string }> = [];
		for (const document of corpus.documents) {
			const content = formatHindsightDocument(document);
			if (content.trim() === "") {
				skippedDocuments += 1;
				continue;
			}
			documents.push({ document, content });
		}

		for (let offset = 0; offset < documents.length; offset += HINDSIGHT_INGEST_BATCH_SIZE) {
			const batch = documents.slice(offset, offset + HINDSIGHT_INGEST_BATCH_SIZE);
			const items = batch.map(({ document, content }) => ({
				content,
				timestamp: document.timestamp,
				context: "conversation transcript",
				document_id: document.id,
				metadata: {
					corpus_id: corpus.id,
					project_id: corpus.projectId,
					document_id: document.id,
				},
			}));
			const response = await this.#request<HindsightRetainResponse>(
				"POST",
				`/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
				{ items, async: false },
				{ timeoutMs: HINDSIGHT_RETAIN_TIMEOUT_MS },
			);
			retainedItems += response.items_count;
			if (response.usage !== undefined && response.usage !== null) {
				usage ??= { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
				usage.input_tokens = (usage.input_tokens ?? 0) + (response.usage.input_tokens ?? 0);
				usage.output_tokens = (usage.output_tokens ?? 0) + (response.usage.output_tokens ?? 0);
				usage.total_tokens = (usage.total_tokens ?? 0) + (response.usage.total_tokens ?? 0);
			}
			this.#context.log("hindsight.ingest.batch", {
				corpusId: corpus.id,
				bankId,
				batch: Math.floor(offset / HINDSIGHT_INGEST_BATCH_SIZE) + 1,
				documents: batch.length,
				itemsCount: response.items_count,
				usage: response.usage ?? null,
			});
		}

		const consolidationStart = Date.now();
		const needsConsolidation = documents.length > 0 ||
			(restoredStats?.pending_consolidation ?? 0) > 0 || (restoredStats?.pending_operations ?? 0) > 0;
		const consolidationOperationId = needsConsolidation ? await this.#settleConsolidation(bankId, corpus.id) : null;
		const consolidationMs = Date.now() - consolidationStart;
		const stats = await this.getBankStats(bankId);

		if (stats.failed_consolidation > 0) {
			throw new Error(
				`Hindsight consolidation failed for ${stats.failed_consolidation} source memories in bank ${bankId}`,
			);
		}

		const result: HindsightIngestResult = {
			corpusId: corpus.id,
			bankId,
			documents: corpus.documents.length + restoredDocuments,
			...(reuse ? { restoredDocuments } : {}),
			retainedItems,
			skippedDocuments,
			consolidationOperationId,
			consolidationMs,
			stats,
			usage,
		};
		this.#ingests.push(result);
		this.#context.log("hindsight.ingest.complete", {
			corpusId: corpus.id,
			bankId,
			retainedItems,
			skippedDocuments,
			consolidationMs,
			stats,
		});
		return result;
	}

	async retrieve(corpusId: string, query: RecallQuery, budget: number, trace = false): Promise<Retrieval> {
		await this.start();
		const bankId = this.#bankIds.get(corpusId);
		if (bankId === undefined) {
			throw new Error(`Hindsight has no ingested bank for corpus ${corpusId}`);
		}
		const level = this.#options.budgetLevel ?? "mid";
		const maxTokens = Math.max(64, Math.floor(Number.isFinite(budget) ? budget : 0));
		const started = Date.now();
		const response = await this.#request<HindsightRecallResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
			{
				query: query.text,
				budget: level,
				max_tokens: maxTokens,
				query_timestamp: query.asOf,
				trace,
				// Entities/chunks/source facts are separate response surfaces with their own
				// token budgets; the benchmark measures the ranked memory-result context.
				include: { entities: null, chunks: null, source_facts: null },
			},
			{ timeoutMs: HINDSIGHT_RECALL_TIMEOUT_MS },
		);
		const latencyMs = Date.now() - started;

		const items: MemoryItem[] = response.results.map(result => {
			const sourceIds = uniqueStrings([result.document_id, ...(result.source_fact_ids ?? [])]);
			const item: MemoryItem = { id: result.id, text: result.text };
			if (typeof result.scores?.final === "number") item.score = result.scores.final;
			if (sourceIds.length > 0) item.sourceIds = sourceIds;
			return item;
		});
		const context = response.results.map(result => `- ${result.text}`).join("\n");
		const contextTokens = this.#context.countTokens(context);

		this.#recalls.push({
			corpusId,
			queryId: query.id,
			budget,
			budgetLevel: level,
			maxTokens,
			results: response.results.length,
			latencyMs,
		});
		this.#context.log("hindsight.recall", {
			corpusId,
			queryId: query.id,
			budget,
			budgetLevel: level,
			maxTokens,
			results: response.results.length,
			contextTokens,
			latencyMs,
		});

		return {
			items,
			metadata: {
				backend: "hindsight",
				engine: "hindsight",
				bankId,
				mode: "recall",
				requestedBudget: budget,
				budgetLevel: level,
				maxTokens,
				returnedResults: response.results.length,
				contextTokens,
				latencyMs,
				include: { entities: false, chunks: false, source_facts: false },
				types: Array.from(new Set(response.results.map(result => result.type ?? "unknown"))).sort(),
				...(trace ? { trace: response.trace, profile: summarizeTrace(response.trace) } : {}),
			},
		};
	}

	async getBankStats(bankId: string): Promise<HindsightBankStats> {
		return await this.#request<HindsightBankStats>(
			"GET",
			`/v1/default/banks/${encodeURIComponent(bankId)}/stats`,
			undefined,
			{ timeoutMs: 60_000 },
		);
	}

	diagnostics(): HindsightServiceDiagnostics {
		return {
			engine: "hindsight",
			image: this.#image,
			imageId: this.#imageId,
			containerName: this.#containerName,
			containerId: this.#provision?.containerId ?? null,
			baseUrl: this.baseUrl,
			networkMode: this.#provision?.networkMode ?? null,
			bindAddress: `127.0.0.1:${this.#port}`,
			dataDir: this.#dataDir,
			llm: {
				provider: "openai",
				model: this.#context.model,
				baseUrl: this.#context.openaiBaseUrl,
				apiKeySource: this.#gatewayKey.source,
			},
			embeddings: {
				provider: "openai",
				model: this.#context.embeddingModel,
				dimensions: this.#context.embeddingDimensions > 0 ? this.#context.embeddingDimensions : null,
				baseUrl: this.#context.openaiBaseUrl,
			},
			reranker: {
				provider: "local",
				model: this.#options.rerankerModel ?? HINDSIGHT_RERANKER_MODEL,
				forceCpu: true,
				enabled: this.#options.reranking !== false,
				bucketBatching: this.#options.bucketBatching ?? false,
				note: "Native CPU cross-encoder settings; disabled reranking uses the native RRF path.",
			},
			bankConfig: {
				perBankLlmConfigSupported: false,
				providerSelection: "server-environment-only",
			},
			ingests: this.#ingests.map(ingest => ({ ...ingest })),
			recalls: this.#recalls.map(recall => ({ ...recall })),
			errors: this.#errors.map(error => ({ ...error })),
		};
	}

	async #startInternal(): Promise<HindsightProvision> {
		const existing = await this.#inspectContainer();
		if (existing !== null) {
			this.#assertOwned(existing);
			if (existing.State.Running !== true) {
				this.#context.log("hindsight.container.start-existing", {
					containerName: this.#containerName,
					status: existing.State.Status ?? "unknown",
				});
				await this.#docker(["start", this.#containerName]);
			}
		} else {
			await this.#assertImagePresent();
			await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
			await chmod(this.#dataDir, 0o700);
			await this.#docker([
				"run",
				"-d",
				"--pull=never",
				"--name",
				this.#containerName,
				"--network",
				"host",
				"--stop-timeout",
				"30",
				"--label",
				"memorybench.role=hindsight",
				"--label",
				`memorybench.run_id=${this.#context.runId}`,
				"--label",
				`memorybench.work_dir=${this.#context.workDir}`,
				"-v",
				`${this.#dataDir}:/home/hindsight/.pg0`,
				"-e",
				`HINDSIGHT_API_HOST=127.0.0.1`,
				"-e",
				`HINDSIGHT_API_PORT=${this.#port}`,
				"-e",
				`HINDSIGHT_API_WORKER_ID=${this.#options.workerId ?? this.#containerName}`,
				"-e",
				"HINDSIGHT_ENABLE_API=true",
				"-e",
				"HINDSIGHT_ENABLE_CP=false",
				"-e",
				"HINDSIGHT_API_LOG_LEVEL=info",
				"-e",
				"HINDSIGHT_API_STORE_DOCUMENT_TEXT=true",
				"-e",
				"HINDSIGHT_API_FAIL_ON_EXTRACTION_ERRORS=true",
				"-e",
				"HINDSIGHT_API_LLM_PROVIDER=openai",
				"-e",
				`HINDSIGHT_API_LLM_API_KEY=${this.#gatewayKey.value}`,
				"-e",
				`HINDSIGHT_API_LLM_BASE_URL=${this.#context.openaiBaseUrl.replace(/\/+$/, "")}`,
				"-e",
				`HINDSIGHT_API_LLM_MODEL=${this.#context.model}`,
				"-e",
				"HINDSIGHT_API_LLM_TIMEOUT=180",
				"-e",
				"HINDSIGHT_API_EMBEDDINGS_PROVIDER=openai",
				"-e",
				`HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY=${this.#gatewayKey.value}`,
				"-e",
				`HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL=${this.#context.openaiBaseUrl.replace(/\/+$/, "")}`,
				"-e",
				`HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL=${this.#context.embeddingModel}`,
				...(this.#context.embeddingDimensions > 0
					? ["-e", `HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS=${this.#context.embeddingDimensions}`]
					: []),
				"-e",
				"HINDSIGHT_API_RERANKER_PROVIDER=local",
				"-e",
				`HINDSIGHT_API_RERANKER_LOCAL_MODEL=${this.#options.rerankerModel ?? HINDSIGHT_RERANKER_MODEL}`,
				"-e",
				"HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU=true",
				"-e",
				`HINDSIGHT_API_ENABLE_RERANKING=${this.#options.reranking !== false}`,
				"-e",
				`HINDSIGHT_API_RERANKER_LOCAL_BUCKET_BATCHING=${this.#options.bucketBatching ?? false}`,
				this.#image,
			]);
			this.#context.log("hindsight.container.started", {
				containerName: this.#containerName,
				image: this.#image,
				dataDir: this.#dataDir,
				networkMode: "host",
				bindAddress: `127.0.0.1:${this.#port}`,
			});
		}

		const imageId = await this.#readImageId();
		await this.#waitForHealth();
		const container = await this.#inspectContainer();
		if (container === null) {
			throw new Error(`Hindsight container ${this.#containerName} disappeared during startup`);
		}
		this.#assertOwned(container);
		const provision: HindsightProvision = {
			baseUrl: this.baseUrl,
			containerName: this.#containerName,
			containerId: container.Id,
			image: this.#image,
			imageId,
			dataDir: this.#dataDir,
			networkMode: container.HostConfig?.NetworkMode ?? "host",
			bindAddress: `127.0.0.1:${this.#port}`,
		};
		this.#provision = provision;
		this.#imageId = imageId;
		this.#context.log("hindsight.ready", { ...provision });
		return provision;
	}

	async #closeInternal(): Promise<void> {
		this.#provision = null;
		this.#startPromise = null;
		const container = await this.#inspectContainer().catch(() => null);
		if (container === null) return;
		this.#assertOwned(container);
		this.#context.log("hindsight.container.stopping", { containerName: this.#containerName });
		try {
			await this.#docker(["stop", "--time", "30", this.#containerName], 90_000);
		} catch (error) {
			this.#recordError("close.stop", error);
			const logs = await this.#containerLogs().catch(() => "");
			throw new Error(`Hindsight container stop failed: ${errorMessage(error)}${logs === "" ? "" : `\n${logs}`}`);
		}
		try {
			await this.#docker(["rm", this.#containerName], 60_000);
		} catch (error) {
			this.#recordError("close.rm", error);
			throw new Error(`Hindsight container remove failed: ${errorMessage(error)}`);
		}
		this.#context.log("hindsight.container.stopped", {
			containerName: this.#containerName,
			dataDir: this.#dataDir,
		});
	}

	async #assertImagePresent(): Promise<void> {
		try {
			await this.#docker(["image", "inspect", this.#image], 60_000);
		} catch (error) {
			throw new Error(
				`Hindsight image ${this.#image} is not available locally; pull it before running the benchmark. ${errorMessage(error)}`,
			);
		}
	}

	async #readImageId(): Promise<string | null> {
		try {
			const stdout = await this.#docker(
				["image", "inspect", "--format", "{{.Id}}", this.#image],
				60_000,
			);
			return stdout.trim() || null;
		} catch (error) {
			this.#recordError("image.inspect", error);
			return null;
		}
	}

	async #waitForHealth(): Promise<void> {
		const deadline = Date.now() + HINDSIGHT_STARTUP_TIMEOUT_MS;
		let lastError = "no health response";
		while (Date.now() < deadline) {
			const container = await this.#inspectContainer().catch(() => null);
			if (container === null) {
				throw new Error(`Hindsight container ${this.#containerName} disappeared during startup`);
			}
			this.#assertOwned(container);
			if (container.State.Running !== true) {
				const logs = await this.#containerLogs().catch(() => "");
				throw new Error(
					`Hindsight container exited during startup (status=${container.State.Status ?? "unknown"}, exit=${container.State.ExitCode ?? "?"}).\n${logs}`,
				);
			}
			try {
				const response = await this.#fetch(`${this.baseUrl}/health`, {
					signal: AbortSignal.timeout(3_000),
				});
				if (response.ok) {
					const body: unknown = await response.json();
					if (body !== null && typeof body === "object" && "status" in body && body.status === "healthy") return;
					lastError =
						body !== null && typeof body === "object" && "status" in body
							? `health status ${String(body.status)}`
							: "health response had no status";
				} else {
					lastError = `health HTTP ${response.status}`;
				}
			} catch (error) {
				lastError = errorMessage(error);
			}
			await sleep(1_000);
		}
		const logs = await this.#containerLogs().catch(() => "");
		throw new Error(
			`Hindsight did not become healthy at ${this.baseUrl} within ${HINDSIGHT_STARTUP_TIMEOUT_MS}ms: ${lastError}\n${logs}`,
		);
	}

	async #createBank(bankId: string): Promise<HindsightBankProfile> {
		return await this.#request<HindsightBankProfile>(
			"PUT",
			`/v1/default/banks/${encodeURIComponent(bankId)}`,
			{},
			{ timeoutMs: 60_000 },
		);
	}

	async #deleteBank(bankId: string): Promise<void> {
		await this.#request(
			"DELETE",
			`/v1/default/banks/${encodeURIComponent(bankId)}`,
			undefined,
			{ timeoutMs: 60_000, allowStatus: [404] },
		);
	}

	async #settleConsolidation(bankId: string, corpusId: string): Promise<string | null> {
		const submitted = await this.#request<HindsightConsolidationResponse>(
			"POST",
			`/v1/default/banks/${encodeURIComponent(bankId)}/consolidate`,
			{},
			{ timeoutMs: 60_000 },
		);
		const operationId = submitted.operation_id;
		this.#context.log("hindsight.consolidation.submitted", {
			corpusId,
			bankId,
			operationId,
			deduplicated: submitted.deduplicated === true,
		});
		const deadline = Date.now() + this.#consolidationTimeoutMs;
		let lastStatus: HindsightOperationStatus | null = null;
		while (Date.now() < deadline) {
			const status = await this.#request<HindsightOperationStatus>(
				"GET",
				`/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`,
				undefined,
				{ timeoutMs: 60_000 },
			);
			lastStatus = status;
			if (status.status === "completed") {
				await this.#waitForConsolidationDrain(bankId, deadline);
				return operationId;
			}
			if (status.status === "failed" || status.status === "cancelled" || status.status === "not_found") {
				throw new Error(
					`Hindsight consolidation ${operationId} ended with status=${status.status}: ${status.error_message ?? JSON.stringify(status.result_metadata ?? {})}`,
				);
			}
			await sleep(1_000);
		}
		throw new Error(
			`Hindsight consolidation ${operationId} did not finish within ${this.#consolidationTimeoutMs}ms (last status=${lastStatus?.status ?? "unknown"})`,
		);
	}

	async #waitForConsolidationDrain(bankId: string, deadline: number): Promise<void> {
		while (Date.now() < deadline) {
			const stats = await this.getBankStats(bankId);
			if (stats.failed_consolidation > 0) {
				throw new Error(
					`Hindsight bank ${bankId} has ${stats.failed_consolidation} permanently failed consolidation memories`,
				);
			}
			if (stats.pending_consolidation === 0 && stats.pending_operations === 0) return;
			await sleep(1_000);
		}
		throw new Error(`Hindsight bank ${bankId} consolidation queue did not drain before the deadline`);
	}

	async #request<T>(
		method: string,
		path: string,
		body: unknown,
		options: JsonRequestOptions = {},
	): Promise<T> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.#gatewayKey.source === "env:MEMORY_BENCH_GATEWAY_API_KEY") {
			headers.Authorization = `Bearer ${this.#gatewayKey.value}`;
		}
		const response = await this.#fetch(`${this.baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			// AbortSignal owns the deadline, without a competing five-minute socket idle timer.
			timeout: false,
			signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
		}).catch(async (error: unknown) => {
			this.#recordError(`${method} ${path}`, new Error(`${errorMessage(error)}\n${await this.#containerLogs()}`));
			throw error;
		});
		const text = await response.text();
		const allowed = options.allowStatus ?? [];
		if (!response.ok && !allowed.includes(response.status)) {
			this.#recordError(`${method} ${path}`, new Error(`${response.status} ${response.statusText}: ${text}`));
			throw new Error(
				`Hindsight ${method} ${path} failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, ERROR_BODY_LIMIT)}`,
			);
		}
		if (text.trim() === "") return undefined as T;
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(`Hindsight ${method} ${path} returned invalid JSON: ${errorMessage(error)}`);
		}
	}

	async #inspectContainer(): Promise<DockerContainer | null> {
		try {
			const stdout = await this.#docker(["inspect", this.#containerName], 30_000);
			return parseDockerInspect(stdout);
		} catch (error) {
			const message = errorMessage(error);
			if (/no such (object|container)/i.test(message)) return null;
			throw error;
		}
	}

	#assertOwned(container: DockerContainer): void {
		const labels = container.Config?.Labels ?? {};
		if (labels["memorybench.role"] !== "hindsight") {
			throw new Error(
				`Docker container ${this.#containerName} exists but is not owned by this benchmark (role=${labels["memorybench.role"] ?? "missing"})`,
			);
		}
		const runId = labels["memorybench.run_id"];
		if (runId !== undefined && runId !== this.#context.runId) {
			throw new Error(
				`Docker container ${this.#containerName} belongs to run ${runId}, not ${this.#context.runId}`,
			);
		}
	}

	async #containerLogs(): Promise<string> {
		try {
			const stdout = await this.#docker(["logs", "--tail", "120", this.#containerName], 30_000);
			return stdout.trim();
		} catch {
			return "";
		}
	}

	async #docker(args: string[], timeoutMs = DOCKER_COMMAND_TIMEOUT_MS): Promise<string> {
		try {
			const { stdout, stderr } = await execFileAsync("docker", args, {
				timeout: timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
				encoding: "utf8",
			});
			const stderrText = stderr;
			if (stderrText.trim() !== "") {
				this.#context.log("hindsight.docker.stderr", {
					args: args.slice(0, 3),
					stderr: stderrText.trim().slice(0, 2000),
				});
			}
			return args[0] === "logs" ? `${stdout}\n${stderr}` : stdout;
		} catch (error) {
			const stderr =
				error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
			const stdout =
				error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
			throw new Error(
				`docker ${args.slice(0, 2).join(" ")} failed: ${errorMessage(error)}${stderr.trim() === "" ? "" : `\n${stderr.trim().slice(0, ERROR_BODY_LIMIT)}`}${stdout.trim() === "" ? "" : `\n${stdout.trim().slice(0, ERROR_BODY_LIMIT)}`}`,
			);
		}
	}

	#recordError(operation: string, error: unknown): void {
		const entry = { at: new Date().toISOString(), operation, message: errorMessage(error) };
		this.#errors.push(entry);
		if (this.#errors.length > 50) this.#errors.shift();
		this.#context.log("hindsight.error", entry);
	}
}

function summarizeTrace(trace: Record<string, unknown> | null | undefined) {
	if (!trace) throw new Error("Hindsight did not return the requested native trace");
	const summary = trace.summary as { phase_metrics: Array<{ phase_name: string; duration_seconds: number; details: Record<string, unknown> }> };
	const reranked = trace.reranked as Array<{ node_id: string }>;
	const merged = trace.rrf_merged as unknown[];
	const retrievals = trace.retrieval_results as Array<{ method_name: string; results: unknown[] }>;
	const candidateCounts: Record<string, number> = { merged: merged.length, ranked: reranked.length };
	for (const retrieval of retrievals) {
		candidateCounts[retrieval.method_name] = (candidateCounts[retrieval.method_name] ?? 0) + retrieval.results.length;
	}
	return {
		stagesMs: Object.fromEntries(summary.phase_metrics.map(stage => [stage.phase_name, stage.duration_seconds * 1000])),
		diagnosticStages: summary.phase_metrics.filter(stage => stage.details.diagnostic || stage.phase_name === "hydrate_results").map(stage => stage.phase_name),
		candidateCounts,
		candidateIds: reranked.map(item => item.node_id).sort(),
	};
}

const sharedServices = new Map<string, HindsightService>();

/** Lazily provision (or reuse) the dedicated loopback Hindsight instance for this run. */
export function getHindsightService(
	context: AdapterContext,
	options: HindsightServiceOptions = {},
): HindsightService {
	const key = `${context.workDir}\0${context.runId}`;
	const existing = sharedServices.get(key);
	if (existing !== undefined) return existing;
	const service = new HindsightService(context, options);
	sharedServices.set(key, service);
	return service;
}

/** Parent-callable helper: start the container and return its loopback endpoint. */
export async function provisionHindsight(
	context: AdapterContext,
	options: HindsightServiceOptions = {},
): Promise<HindsightProvision> {
	return await getHindsightService(context, options).start();
}
