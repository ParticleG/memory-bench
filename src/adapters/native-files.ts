import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { VERSION, getAgentDbPath } from "@oh-my-pi/pi-utils";
import { registerLogSink } from "@oh-my-pi/pi-utils/logger";
import type { LogEvent } from "@oh-my-pi/pi-utils/logger";
import {
	buildMemoryToolDeveloperInstructions,
	getMemoryRoot,
	startMemoryStartupTask,
} from "@oh-my-pi/pi-coding-agent/memories/index";
import {
	cfgMemoriesMaxRolloutAgeDays,
	cfgMemoriesMaxRawMemoriesForGlobal,
	cfgMemoriesMaxRolloutsPerStartup,
	cfgMemoriesMinRolloutIdleHours,
	cfgMemoriesPhase1InputTokenLimit,
	cfgMemoriesRolloutPayloadPercent,
	cfgMemoriesStage1Concurrency,
	cfgMemoriesSummaryInjectionTokenLimit,
	cfgMemoriesThreadScanLimit,
} from "@oh-my-pi/pi-coding-agent/memories/settings";
import { closeMemoryDb, openMemoryDb } from "@oh-my-pi/pi-coding-agent/memories/storage";
import { cfgMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { runSharpshooterConsolidation } from "@oh-my-pi/pi-coding-agent/sharpshooter/consolidate";
import {
	flushSharpshooterExtraction,
	maybeStartSharpshooterExtraction,
	resolveSharpshooterModel,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/extract";
import { readSharpshooterState, sharpshooterBankDir } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { listSharpshooterDeltas, sharpshooterQueueDepth } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import {
	cfgSharpshooterInjectionTokenLimit,
	cfgSharpshooterIntervalMinutes,
	cfgSharpshooterModel,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/settings";
import { SHARPSHOOTER_MEMORY_FILES } from "@oh-my-pi/pi-coding-agent/sharpshooter/types";

import type {
	AdapterContext,
	AdapterFactory,
	Corpus,
	MemoryAdapter,
	NativeHost,
	RecallQuery,
	Retrieval,
} from "../types";
import {
	collectFileStats,
	createActiveSession,
	createReplaySession,
	modelSelector,
	parseReplayTimestamp,
	readTextIfExists,
	safeSegment,
	selectGatewayModel,
} from "./native-replay";

const ENGINE = `@oh-my-pi/pi-coding-agent@${VERSION}`;
const SHARPSHOOTER_EXTRACTION_TIMEOUT_MS = 180_000;
const CAPTURED_LOG_LIMIT = 200;
const LOCAL_INJECTED_FILES: Record<string, true> = {
	"memory_summary.md": true,
	"learned.md": true,
};
const SHARPSHOOTER_INJECTED_FILES: Record<string, true> = {
	"architecture.md": true,
	"product.md": true,
	"style.md": true,
};

interface CapturedLog {
	level: LogEvent["level"];
	message: string;
	details: Record<string, unknown>;
}

interface InjectionAudit {
	injection: string;
	bytes: number;
	tokens: number;
	sources: Array<{ path: string; bytes: number; complete: boolean; nonEmpty: boolean }>;
	truncated: boolean;
}

interface LocalCorpusStore {
	corpusId: string;
	projectId: string;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	memoryRoot: string;
	host: NativeHost;
	model: Model;
	diagnostics: Record<string, unknown>;
	lastInjection: InjectionAudit;
}

interface SharpshooterCorpusStore {
	corpusId: string;
	projectId: string;
	agentDir: string;
	cwd: string;
	sessionDir: string;
	settleSessionId: string;
	host: NativeHost;
	model: Model;
	diagnostics: Record<string, unknown>;
	lastInjection: InjectionAudit;
}

function captureLog(target: CapturedLog[], admitted: (message: string) => boolean, event: LogEvent): void {
	if (!admitted(event.message)) return;
	const details: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(event.context ?? {})) {
		details[key] = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
	}
	target.push({ level: event.level, message: event.message, details });
	if (target.length > CAPTURED_LOG_LIMIT) target.shift();
}

function countLogEvents(events: readonly CapturedLog[], message: string): number {
	return events.filter(event => event.message.includes(message)).length;
}

async function auditInjection(
	context: AdapterContext,
	injection: string | undefined,
	root: string,
	sources: readonly string[],
): Promise<InjectionAudit> {
	const value = injection ?? "";
	const entries: InjectionAudit["sources"] = [];
	for (const relativePath of sources) {
		const text = await readTextIfExists(path.join(root, relativePath));
		const trimmed = text?.trim() ?? "";
		entries.push({
			path: relativePath,
			bytes: text ? Buffer.byteLength(text) : 0,
			nonEmpty: trimmed.length > 0,
			complete: trimmed.length > 0 && value.includes(trimmed),
		});
	}
	const configured = entries.filter(entry => entry.nonEmpty);
	return {
		injection: value,
		bytes: Buffer.byteLength(value),
		tokens: context.countTokens(value),
		sources: entries,
		truncated: configured.length > 0 && configured.some(entry => !entry.complete),
	};
}

interface Stage1OutputSummary {
	threadId: string;
	sourceUpdatedAt: number;
	rawChars: number;
	summaryChars: number;
	slug: string | null;
}

interface JobSummary {
	kind: string;
	jobKey: string;
	status: string;
	lastError: string | null;
	retryRemaining: number;
}

interface LocalDbDiagnostics {
	threads: number;
	stage1Outputs: number;
	outputs: Stage1OutputSummary[];
	jobs: JobSummary[];
	errors: string[];
}

async function readLocalDbDiagnostics(agentDir: string): Promise<LocalDbDiagnostics> {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		const threads = db.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count?: number } | undefined;
		const outputs = db
			.prepare(
				"SELECT thread_id, source_updated_at, length(raw_memory) AS raw_chars, length(rollout_summary) AS summary_chars, rollout_slug FROM stage1_outputs ORDER BY source_updated_at",
			)
			.all() as Array<{
			thread_id: string;
			source_updated_at: number;
			raw_chars: number;
			summary_chars: number;
			rollout_slug: string | null;
		}>;
		const jobs = db
			.prepare("SELECT kind, job_key, status, last_error, retry_remaining FROM jobs ORDER BY kind, job_key")
			.all() as Array<{
			kind: string;
			job_key: string;
			status: string;
			last_error: string | null;
			retry_remaining: number;
		}>;
		const summaries = jobs.map(row => ({
			kind: row.kind,
			jobKey: row.job_key,
			status: row.status,
			lastError: row.last_error,
			retryRemaining: row.retry_remaining,
		}));
		return {
			threads: threads?.count ?? 0,
			stage1Outputs: outputs.length,
			outputs: outputs.map(row => ({
				threadId: row.thread_id,
				sourceUpdatedAt: row.source_updated_at,
				rawChars: row.raw_chars,
				summaryChars: row.summary_chars,
				slug: row.rollout_slug,
			})),
			jobs: summaries,
			errors: summaries.flatMap(job => (job.lastError ? [`${job.kind}/${job.jobKey}: ${job.lastError}`] : [])),
		};
	} finally {
		closeMemoryDb(db);
	}
}

interface LocalReplaySession {
	documentId: string;
	sessionId: string;
	sessionFile: string;
	baseTimestamp: number;
	messageCount: number;
	ageHours: number;
	eligible: boolean;
}

async function awaitLocalMemoryStartup(options: {
	host: NativeHost;
	model: Model;
	agentDir: string;
	active: { manager: SessionManager; sessionId: string; sessionFile: string };
}): Promise<void> {
	let started = false;
	let finish: (() => void) | undefined;
	const ended = new Promise<void>(resolve => {
		finish = resolve;
	});
	const controller = new AbortController();
	const session = {
		agent: { state: { messages: [] as unknown[] }, metadataForProvider: () => undefined },
		sessionManager: options.active.manager,
		settings: options.host.settings,
		model: options.model,
		sessionId: options.active.sessionId,
		isDisposed: false,
		beginLocalMemoryStartup: () => {
			started = true;
			return controller.signal;
		},
		endLocalMemoryStartup: (signal: AbortSignal) => {
			if (signal === controller.signal) finish?.();
		},
	} as unknown as AgentSession;
	startMemoryStartupTask({
		session,
		settings: options.host.settings,
		modelRegistry: options.host.modelRegistry,
		agentDir: options.agentDir,
		taskDepth: 0,
	});
	if (!started) {
		throw new Error("omp local memory startup did not start (backend disabled, subagent depth, or missing session file)");
	}
	await ended;
}

async function ingestLocalCorpus(options: {
	context: AdapterContext;
	corpus: Corpus;
	generation: number;
	capturedLogs: CapturedLog[];
}): Promise<LocalCorpusStore> {
	const { context, corpus, generation, capturedLogs } = options;
	const logStart = capturedLogs.length;
	const baseDir = path.join(
		context.workDir,
		"native",
		"local",
		`ingest-${generation}`,
		`${safeSegment(corpus.projectId)}-${safeSegment(corpus.id)}`,
	);
	const agentDir = path.join(baseDir, "agent");
	const cwd = path.join(baseDir, "project");
	const sessionDir = path.join(baseDir, "sessions");
	await Promise.all([
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(path.dirname(getAgentDbPath(agentDir)), { recursive: true }),
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(sessionDir, { recursive: true }),
	]);

	const host = await context.createNativeHost(agentDir, cwd);
	cfgMemoryBackend.override(host.settings, "local");
	const model = selectGatewayModel(host, context.model);

	const documents = corpus.documents
		.map((document, index) => ({
			document,
			index,
			timestamp: parseReplayTimestamp(document.timestamp, `corpus ${corpus.id} document ${document.id}`),
		}))
		.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

	const sessions: LocalReplaySession[] = [];
	const skippedDocuments: Array<{ id: string; reason: string; timestamp?: string }> = [];
	for (const entry of documents) {
		if (entry.document.messages.length === 0 || !entry.document.messages.some(message => message.content.trim())) {
			skippedDocuments.push({ id: entry.document.id, reason: "empty-document", timestamp: entry.document.timestamp });
			continue;
		}
		const replay = await createReplaySession({
			cwd,
			sessionDir,
			model,
			baseTimestamp: entry.timestamp,
			messages: entry.document.messages,
		});
		sessions.push({
			documentId: entry.document.id,
			sessionId: replay.sessionId,
			sessionFile: replay.sessionFile,
			baseTimestamp: entry.timestamp,
			messageCount: replay.messageCount,
			ageHours: (Date.now() - entry.timestamp) / 3_600_000,
			eligible: false,
		});
	}

	const minIdleHours = cfgMemoriesMinRolloutIdleHours.get(host.settings);
	const maxAgeDays = cfgMemoriesMaxRolloutAgeDays.get(host.settings);
	for (const session of sessions) {
		session.eligible = session.ageHours >= minIdleHours && session.ageHours <= maxAgeDays * 24;
	}
	const eligibleSessions = sessions.filter(session => session.eligible).length;
	const maxRolloutsDefault = cfgMemoriesMaxRolloutsPerStartup.get(host.settings);
	const threadScanDefault = cfgMemoriesThreadScanLimit.get(host.settings);
	let startupPasses = 0;
	let completedSessions = 0;
	const eligibleSessionIds = new Set(sessions.filter(session => session.eligible).map(session => session.sessionId));

	if (sessions.length > 0) {
		const active = await createActiveSession(cwd, sessionDir);
		const apiKey = await host.modelRegistry.getApiKey(model, active.sessionId);
		if (!apiKey) {
			throw new Error(`omp local memory has no API key for ${modelSelector(model)} in the native gateway registry`);
		}
		cfgMemoriesMaxRolloutsPerStartup.override(host.settings, Math.max(maxRolloutsDefault, sessions.length));
		cfgMemoriesThreadScanLimit.override(host.settings, Math.max(threadScanDefault, sessions.length + 1));
		for (;;) {
			const previousCompleted = completedSessions;
			await awaitLocalMemoryStartup({ host, model, agentDir, active });
			startupPasses += 1;
			const snapshot = await readLocalDbDiagnostics(agentDir);
			completedSessions = snapshot.jobs.filter(
				job => job.kind === "memory_stage1" && job.status === "done" && eligibleSessionIds.has(job.jobKey),
			).length;
			context.log("native.local.startup.pass", {
				corpusId: corpus.id,
				startupPasses,
				completedSessions,
				eligibleSessions,
			});
			if (completedSessions >= eligibleSessions) break;
			if (snapshot.errors.length > 0 || completedSessions <= previousCompleted) {
				throw new Error(
					`omp local memory did not settle: ${completedSessions}/${eligibleSessions} eligible sessions completed after ${startupPasses} startups${
						snapshot.errors.length ? `; ${snapshot.errors.join("; ")}` : ""
					}`,
				);
			}
		}
	}

	const db = await readLocalDbDiagnostics(agentDir);
	const corpusLogs = capturedLogs.slice(logStart);
	const startupFailures = corpusLogs
		.filter(event => event.message === "Memory startup failed")
		.map(event => String(event.details.error ?? event.details.reason ?? event.message));
	const memoryRoot = getMemoryRoot(agentDir, cwd);
	const injection = await buildMemoryToolDeveloperInstructions(agentDir, cwd, host.settings);
	const injectionAudit = await auditInjection(context, injection, memoryRoot, ["memory_summary.md", "learned.md"]);
	const fileStats = await collectFileStats(memoryRoot, LOCAL_INJECTED_FILES);
	const lifecycle = {
		backend: cfgMemoryBackend.get(host.settings),
		maxRolloutsPerStartup: cfgMemoriesMaxRolloutsPerStartup.get(host.settings),
		maxRolloutsDefault,
		threadScanLimit: cfgMemoriesThreadScanLimit.get(host.settings),
		threadScanDefault,
		maxRolloutAgeDays: maxAgeDays,
		minRolloutIdleHours: minIdleHours,
		stage1Concurrency: cfgMemoriesStage1Concurrency.get(host.settings),
		phase1InputTokenLimit: cfgMemoriesPhase1InputTokenLimit.get(host.settings),
		rolloutPayloadPercent: cfgMemoriesRolloutPayloadPercent.get(host.settings),
		maxRawMemoriesForGlobal: cfgMemoriesMaxRawMemoriesForGlobal.get(host.settings),
		summaryInjectionTokenLimit: cfgMemoriesSummaryInjectionTokenLimit.get(host.settings),
	};
	const diagnostics: Record<string, unknown> = {
		agentDir,
		cwd,
		sessionDir,
		memoryRoot,
		engine: ENGINE,
		host: {
			model: `${model.provider}/${model.id}`,
			defaultRole: host.settings.getModelRole("default") ?? null,
			smolRole: host.settings.getModelRole("smol") ?? null,
		},
		corpus: {
			id: corpus.id,
			projectId: corpus.projectId,
			language: corpus.language,
			documents: corpus.documents.length,
			persistedSessions: sessions.length,
			eligibleSessions,
			skippedDocuments,
		},
		replayClock: {
			source: "document.timestamp",
			oldest: documents.length > 0 ? new Date(documents[0]!.timestamp).toISOString() : null,
			newest: documents.length > 0 ? new Date(documents[documents.length - 1]!.timestamp).toISOString() : null,
			evaluatedAt: new Date().toISOString(),
			note: "Session rollout mtimes use corpus timestamps; session-header creation times use the real clock and are not used by the age/idle filter.",
		},
		sessions,
		lifecycle,
		stage1: {
			threads: db.threads,
			outputs: db.stage1Outputs,
			completedThreads: completedSessions,
			pendingEligibleThreads: eligibleSessions - completedSessions,
			noOutputThreads: Math.max(0, completedSessions - db.stage1Outputs),
			outputRows: db.outputs,
		},
		jobs: db.jobs,
		logs: corpusLogs,
		stage1Skipped: {
			tooFresh: sessions.filter(session => session.ageHours < minIdleHours).length,
			tooOld: sessions.filter(session => session.ageHours > maxAgeDays * 24).length,
			emptyDocuments: skippedDocuments.length,
		},
		settling: {
			mode: "forced-startup-task",
			ran: sessions.length > 0,
			startupPasses,
			note: "Native startup tasks repeat until every eligible session job is done; native concurrency, prompts, idle/age policy and per-startup claiming are preserved. No scheduler delay is measured.",
		},
		files: fileStats,
		injection: {
			bytes: injectionAudit.bytes,
			tokens: injectionAudit.tokens,
			sources: injectionAudit.sources,
			truncated: injectionAudit.truncated,
			nativeOrder: ["memory_instructions"],
			injectedArtifacts: ["memory_summary.md", "learned.md"],
			onDemandArtifacts: ["MEMORY.md", "skills/<name>/SKILL.md"],
			note: "MEMORY.md and skills are referenced by the native instructions but are not statically injected; only memory_summary.md and learned.md are.",
		},
	};
	const pipelineErrors = [...db.errors, ...startupFailures];
	if (pipelineErrors.length > 0) {
		throw new Error(`omp local memory pipeline reported errors:\n${pipelineErrors.join("\n")}`);
	}
	const summary = fileStats.files.find(file => file.path === "memory_summary.md");
	if (!summary && db.stage1Outputs > 0) {
		const phase2 = db.jobs.find(job => job.kind === "memory_consolidate_global");
		throw new Error(
			`omp local memory produced ${db.stage1Outputs} stage1 outputs but no memory_summary.md (phase2 status: ${
				phase2?.status ?? "missing"
			}${phase2?.lastError ? `, error: ${phase2.lastError}` : ""})`,
		);
	}
	context.log("native.local.ingest.corpus", {
		corpusId: corpus.id,
		projectId: corpus.projectId,
		documents: corpus.documents.length,
		sessions: sessions.length,
		eligibleSessions,
		stage1Outputs: db.stage1Outputs,
		injectionTokens: injectionAudit.tokens,
	});
	return {
		corpusId: corpus.id,
		projectId: corpus.projectId,
		agentDir,
		cwd,
		sessionDir,
		memoryRoot,
		host,
		model,
		diagnostics,
		lastInjection: injectionAudit,
	};
}

async function localRetrieval(store: LocalCorpusStore, context: AdapterContext): Promise<Retrieval> {
	const injection = await buildMemoryToolDeveloperInstructions(store.agentDir, store.cwd, store.host.settings);
	const audit = await auditInjection(context, injection, store.memoryRoot, ["memory_summary.md", "learned.md"]);
	store.lastInjection = audit;
	const fileStats = await collectFileStats(store.memoryRoot, LOCAL_INJECTED_FILES);
	return {
		items: audit.injection.trim() ? [{ text: audit.injection }] : [],
		metadata: {
			nativeBackend: "local",
			engine: ENGINE,
			injectionBytes: audit.bytes,
			injectionTokens: audit.tokens,
			truncated: audit.truncated,
			sources: audit.sources,
			files: fileStats.files,
			nativeOrder: ["memory_instructions"],
			asOfHonored: false,
			asOfNote: "Native local memory consolidates the complete ingested corpus; no per-query time slicing is supported.",
		},
	};
}

export const createLocalAdapter: AdapterFactory = async (context: AdapterContext): Promise<MemoryAdapter> => {
	const stores = new Map<string, LocalCorpusStore>();
	const capturedLogs: CapturedLog[] = [];
	let generation = 0;
	let closed = false;
	const disposeSink = registerLogSink(event => captureLog(capturedLogs, message => message.startsWith("Memory "), event));

	return {
		id: "local",
		name: "omp native local rollout memory",
		mode: "static-injection",
		async ingest(corpora: Corpus[]): Promise<void> {
			if (closed) throw new Error("local adapter is closed");
			await Promise.allSettled([...stores.values()].map(store => store.host.settings.flush()));
			generation += 1;
			stores.clear();
			for (const corpus of corpora) {
				const store = await ingestLocalCorpus({ context, corpus, generation, capturedLogs });
				stores.set(corpus.id, store);
			}
		},
		async retrieve(query: RecallQuery, budget: number): Promise<Retrieval> {
			if (closed) throw new Error("local adapter is closed");
			const store = stores.get(query.corpusId);
			if (!store) throw new Error(`no local memory store for corpus ${query.corpusId}`);
			if (query.projectId !== store.projectId) {
				throw new Error(`local scope mismatch: query project ${query.projectId} != corpus project ${store.projectId}`);
			}
			const retrieval = await localRetrieval(store, context);
			return {
				...retrieval,
				metadata: {
					...(retrieval.metadata ?? {}),
					corpusId: query.corpusId,
					projectId: query.projectId,
					queryId: query.id,
					asOf: query.asOf,
					requestedBudgetTokens: budget,
					budgetPolicy: "parent-global-budget",
				},
			};
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			disposeSink();
			await Promise.allSettled([...stores.values()].map(store => store.host.settings.flush()));
		},
		diagnostics(): Record<string, unknown> {
			return {
				backend: "local",
				engine: ENGINE,
				version: VERSION,
				mode: "static-injection",
				closed,
				corpora: Object.fromEntries(
					[...stores.values()].map(store => [
						store.corpusId,
						{
							...store.diagnostics,
							lastInjection: {
								bytes: store.lastInjection.bytes,
								tokens: store.lastInjection.tokens,
								truncated: store.lastInjection.truncated,
								sources: store.lastInjection.sources,
							},
						},
					]),
				),
				logEvents: capturedLogs,
				lifecycleNote:
					"Corpus rollout mtimes are replay timestamps. Local memory is settled by a forced startup pass, not by claiming live freshness.",
			};
		},
	};
};

interface SharpshooterDeltaSummary {
	sessions: number;
	deltas: number;
	kinds: Record<string, number>;
}

async function summarizeSharpshooterQueue(agentDir: string, cwd: string): Promise<SharpshooterDeltaSummary> {
	const groups = await listSharpshooterDeltas(agentDir, cwd);
	const kinds: Record<string, number> = {};
	for (const group of groups) {
		for (const { delta } of group.deltas) kinds[delta.kind] = (kinds[delta.kind] ?? 0) + 1;
	}
	return {
		sessions: groups.length,
		deltas: groups.reduce((sum, group) => sum + group.deltas.length, 0),
		kinds,
	};
}

async function settleSharpshooter(options: {
	agentDir: string;
	cwd: string;
	host: NativeHost;
	sessionId: string;
}): Promise<Array<Record<string, unknown>>> {
	const results: Array<Record<string, unknown>> = [];
	for (let pass = 0; pass < 3; pass++) {
		const depthBefore = await sharpshooterQueueDepth(options.agentDir, options.cwd);
		const result = await runSharpshooterConsolidation({
			agentDir: options.agentDir,
			cwd: options.cwd,
			settings: options.host.settings,
			modelRegistry: options.host.modelRegistry,
			sessionId: options.sessionId,
			force: true,
		});
		results.push({ depthBefore, ...result });
		if (!result.ran && result.reason === "error") {
			throw new Error(`omp sharpshooter consolidation failed: ${result.error ?? "unknown error"}`);
		}
		if (!result.ran && result.reason === "no_model") {
			throw new Error("omp sharpshooter consolidation found no extraction model");
		}
		if (!result.ran && result.reason === "locked") {
			throw new Error("omp sharpshooter consolidation lock was held by another process");
		}
		if (!result.ran && (result.reason === "empty" || result.reason === "not_due")) break;
		const depthAfter = await sharpshooterQueueDepth(options.agentDir, options.cwd);
		if (depthAfter === 0) break;
	}
	const remaining = await sharpshooterQueueDepth(options.agentDir, options.cwd);
	if (remaining > 0) throw new Error(`omp sharpshooter left ${remaining} deltas queued after forced consolidation`);
	return results;
}

async function ingestSharpshooterCorpus(options: {
	context: AdapterContext;
	corpus: Corpus;
	generation: number;
	capturedLogs: CapturedLog[];
}): Promise<SharpshooterCorpusStore> {
	const { context, corpus, generation, capturedLogs } = options;
	const logStart = capturedLogs.length;
	const baseDir = path.join(
		context.workDir,
		"native",
		"sharpshooter",
		`ingest-${generation}`,
		`${safeSegment(corpus.projectId)}-${safeSegment(corpus.id)}`,
	);
	const agentDir = path.join(baseDir, "agent");
	const cwd = path.join(baseDir, "project");
	const sessionDir = path.join(baseDir, "sessions");
	await Promise.all([
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(sessionDir, { recursive: true }),
	]);

	const host = await context.createNativeHost(agentDir, cwd);
	cfgMemoryBackend.override(host.settings, "sharpshooter");
	const gatewayModel = selectGatewayModel(host, context.model);
	cfgSharpshooterModel.override(host.settings, modelSelector(gatewayModel));
	const model = await resolveSharpshooterModel(host.settings, host.modelRegistry);
	if (!model) {
		throw new Error(
			`omp sharpshooter has no extraction model (sharpshooter.model=${cfgSharpshooterModel.get(host.settings) ?? "unset"}, smol=${host.settings.getModelRole("smol") ?? "unset"})`,
		);
	}
	const active = await createActiveSession(cwd, sessionDir);
	const apiKey = await host.modelRegistry.getApiKey(model, active.sessionId);
	if (!apiKey) {
		throw new Error(`omp sharpshooter has no API key for ${modelSelector(model)} in the native gateway registry`);
	}

	const documents = corpus.documents
		.map((document, index) => ({
			document,
			index,
			timestamp: parseReplayTimestamp(document.timestamp, `corpus ${corpus.id} document ${document.id}`),
		}))
		.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

	const sessions: Array<{
		documentId: string;
		sessionId: string;
		sessionFile: string;
		baseTimestamp: number;
		messageCount: number;
		userPrompts: number;
	}> = [];
	const skips = { emptyDocuments: 0, tooShortPrompt: 0, slashPrompt: 0 };
	let extractionAttempts = 0;
	const skippedDocuments: Array<{ id: string; reason: string; timestamp: string }> = [];
	for (const entry of documents) {
		if (entry.document.messages.length === 0 || !entry.document.messages.some(message => message.content.trim())) {
			skips.emptyDocuments += 1;
			skippedDocuments.push({ id: entry.document.id, reason: "empty-document", timestamp: entry.document.timestamp });
			continue;
		}
		const replay = await createReplaySession({
			cwd,
			sessionDir,
			model,
			baseTimestamp: entry.timestamp,
			messages: entry.document.messages,
		});
		const extractionState = {
			messages: replay.messages,
			sessionId: replay.sessionId,
			sessionManager: replay.manager,
			settings: host.settings,
			modelRegistry: host.modelRegistry,
			isDisposed: false,
		};
		const session = extractionState as unknown as AgentSession;
		let userPrompts = 0;
		for (const message of replay.messages) {
			if (message.role !== "user") continue;
			userPrompts += 1;
			const text = typeof message.content === "string" ? message.content.trim() : "";
			if (text.startsWith("/")) skips.slashPrompt += 1;
			else if (text.length < 16) skips.tooShortPrompt += 1;
			extractionAttempts += 1;
			maybeStartSharpshooterExtraction({
				session,
				settings: host.settings,
				modelRegistry: host.modelRegistry,
				agentDir,
				message: message as AgentMessage,
			});
			await flushSharpshooterExtraction(session, SHARPSHOOTER_EXTRACTION_TIMEOUT_MS);
		}
		extractionState.isDisposed = true;
		sessions.push({
			documentId: entry.document.id,
			sessionId: replay.sessionId,
			sessionFile: replay.sessionFile,
			baseTimestamp: entry.timestamp,
			messageCount: replay.messageCount,
			userPrompts,
		});
	}

	const corpusLogs = capturedLogs.slice(logStart);
	const queueBefore = await summarizeSharpshooterQueue(agentDir, cwd);
	const settlement = await settleSharpshooter({ agentDir, cwd, host, sessionId: active.sessionId });
	const queueAfter = await summarizeSharpshooterQueue(agentDir, cwd);
	if (queueAfter.deltas > 0) {
		throw new Error(`omp sharpshooter queued ${queueAfter.deltas} deltas after extraction settlement completed`);
	}
	const state = await readSharpshooterState(agentDir, cwd);
	const injection = await sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, host.settings);
	const bankDir = sharpshooterBankDir(agentDir, cwd);
	const injectionAudit = await auditInjection(context, injection, bankDir, SHARPSHOOTER_MEMORY_FILES);
	const fileStats = await collectFileStats(bankDir, SHARPSHOOTER_INJECTED_FILES);
	const lifecycle = {
		backend: cfgMemoryBackend.get(host.settings),
		intervalMinutes: cfgSharpshooterIntervalMinutes.get(host.settings),
		injectionTokenLimit: cfgSharpshooterInjectionTokenLimit.get(host.settings),
		configuredModel: cfgSharpshooterModel.get(host.settings) ?? null,
		smolRole: host.settings.getModelRole("smol") ?? null,
		resolvedModel: `${model.provider}/${model.id}`,
		extractionTimeoutMs: SHARPSHOOTER_EXTRACTION_TIMEOUT_MS,
	};
	const diagnostics: Record<string, unknown> = {
		agentDir,
		cwd,
		sessionDir,
		bankDir,
		engine: ENGINE,
		host: {
			model: `${gatewayModel.provider}/${gatewayModel.id}`,
			writer: `${model.provider}/${model.id}`,
		},
		corpus: {
			id: corpus.id,
			projectId: corpus.projectId,
			language: corpus.language,
			documents: corpus.documents.length,
			persistedSessions: sessions.length,
			skippedDocuments,
		},
		replayClock: {
			source: "document.timestamp",
			oldest: documents.length > 0 ? new Date(documents[0]!.timestamp).toISOString() : null,
			newest: documents.length > 0 ? new Date(documents[documents.length - 1]!.timestamp).toISOString() : null,
			evaluatedAt: new Date().toISOString(),
			note: "Sharpshooter delta timestamps come from the real extraction clock; document order is preserved by sequential ingestion.",
		},
		sessions,
		lifecycle,
		extraction: {
			attempts: extractionAttempts,
			skips,
			queueBefore,
			queueAfter,
			logs: corpusLogs,
			rejected: {
				nonObject: countLogEvents(corpusLogs, "rejected non-object delta"),
				emptyStatement: countLogEvents(corpusLogs, "rejected delta with empty statement"),
				unverifiableEvidence: countLogEvents(corpusLogs, "rejected delta with unverifiable evidence"),
				invalidKind: countLogEvents(corpusLogs, "rejected delta with invalid kind"),
				invalidSource: countLogEvents(corpusLogs, "rejected delta with invalid source"),
				invalidFriction: countLogEvents(corpusLogs, "rejected delta with invalid friction"),
				malformedToolCall: countLogEvents(corpusLogs, "malformed record_deltas call"),
				failedCalls: countLogEvents(corpusLogs, "Sharpshooter extraction failed"),
			},
			evidencePolicy:
				"Native Sharpshooter 16-character prompt filter, exact-substring evidence admission, and friction rules are unchanged.",
		},
		settling: {
			mode: "forced-consolidation",
			attempts: settlement.length,
			ran: settlement.filter(result => result.ran === true).length,
			results: settlement,
		},
		state,
		files: fileStats,
		injection: {
			bytes: injectionAudit.bytes,
			tokens: injectionAudit.tokens,
			sources: injectionAudit.sources,
			truncated: injectionAudit.truncated,
			nativeOrder: [...SHARPSHOOTER_MEMORY_FILES],
			injectedArtifacts: [...SHARPSHOOTER_MEMORY_FILES],
		},
	};
	context.log("native.sharpshooter.ingest.corpus", {
		corpusId: corpus.id,
		projectId: corpus.projectId,
		documents: corpus.documents.length,
		sessions: sessions.length,
		extractionAttempts,
		admittedDeltas: queueBefore.deltas,
		settlementPasses: settlement.length,
		injectionTokens: injectionAudit.tokens,
	});
	return {
		corpusId: corpus.id,
		projectId: corpus.projectId,
		agentDir,
		cwd,
		sessionDir,
		settleSessionId: active.sessionId,
		host,
		model,
		diagnostics,
		lastInjection: injectionAudit,
	};
}

async function sharpshooterRetrieval(store: SharpshooterCorpusStore, context: AdapterContext): Promise<Retrieval> {
	const depth = await sharpshooterQueueDepth(store.agentDir, store.cwd);
	let retrievalSettlement: Record<string, unknown> | undefined;
	if (depth > 0) {
		const results = await settleSharpshooter({
			agentDir: store.agentDir,
			cwd: store.cwd,
			host: store.host,
			sessionId: store.settleSessionId,
		});
		retrievalSettlement = { depthBefore: depth, results };
		store.diagnostics.retrievalSettlement = retrievalSettlement;
	}
	const injection = await sharpshooterBackend.buildDeveloperInstructions(store.agentDir, store.cwd, store.host.settings);
	const bankDir = sharpshooterBankDir(store.agentDir, store.cwd);
	const audit = await auditInjection(context, injection, bankDir, SHARPSHOOTER_MEMORY_FILES);
	store.lastInjection = audit;
	const fileStats = await collectFileStats(bankDir, SHARPSHOOTER_INJECTED_FILES);
	return {
		items: audit.injection.trim() ? [{ text: audit.injection }] : [],
		metadata: {
			nativeBackend: "sharpshooter",
			engine: ENGINE,
			injectionBytes: audit.bytes,
			injectionTokens: audit.tokens,
			truncated: audit.truncated,
			sources: audit.sources,
			files: fileStats.files,
			nativeOrder: [...SHARPSHOOTER_MEMORY_FILES],
			asOfHonored: false,
			asOfNote: "Sharpshooter holds a consolidated project-decision snapshot; it does not time-slice per query.",
			retrievalSettlement,
		},
	};
}

export const createSharpshooterAdapter: AdapterFactory = async (context: AdapterContext): Promise<MemoryAdapter> => {
	const stores = new Map<string, SharpshooterCorpusStore>();
	const capturedLogs: CapturedLog[] = [];
	let generation = 0;
	let closed = false;
	const disposeSink = registerLogSink(event =>
		captureLog(capturedLogs, message => message.startsWith("Sharpshooter "), event),
	);

	return {
		id: "sharpshooter",
		name: "omp native sharpshooter decision memory",
		mode: "static-injection",
		async ingest(corpora: Corpus[]): Promise<void> {
			if (closed) throw new Error("sharpshooter adapter is closed");
			await Promise.allSettled([...stores.values()].map(store => store.host.settings.flush()));
			generation += 1;
			stores.clear();
			for (const corpus of corpora) {
				const store = await ingestSharpshooterCorpus({ context, corpus, generation, capturedLogs });
				stores.set(corpus.id, store);
			}
		},
		async retrieve(query: RecallQuery, budget: number): Promise<Retrieval> {
			if (closed) throw new Error("sharpshooter adapter is closed");
			const store = stores.get(query.corpusId);
			if (!store) throw new Error(`no sharpshooter memory store for corpus ${query.corpusId}`);
			if (query.projectId !== store.projectId) {
				throw new Error(
					`sharpshooter scope mismatch: query project ${query.projectId} != corpus project ${store.projectId}`,
				);
			}
			const retrieval = await sharpshooterRetrieval(store, context);
			return {
				...retrieval,
				metadata: {
					...(retrieval.metadata ?? {}),
					corpusId: query.corpusId,
					projectId: query.projectId,
					queryId: query.id,
					asOf: query.asOf,
					requestedBudgetTokens: budget,
					budgetPolicy: "parent-global-budget",
				},
			};
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			disposeSink();
			await Promise.allSettled([...stores.values()].map(store => store.host.settings.flush()));
		},
		diagnostics(): Record<string, unknown> {
			return {
				backend: "sharpshooter",
				engine: ENGINE,
				version: VERSION,
				mode: "static-injection",
				closed,
				corpora: Object.fromEntries(
					[...stores.values()].map(store => [
						store.corpusId,
						{
							...store.diagnostics,
							lastInjection: {
								bytes: store.lastInjection.bytes,
								tokens: store.lastInjection.tokens,
								truncated: store.lastInjection.truncated,
								sources: store.lastInjection.sources,
							},
						},
					]),
				),
				logEvents: capturedLogs,
				lifecycleNote:
					"Sharpshooter queue timestamps are real extraction times; replay order comes from sequential corpus ingestion, and consolidation is forced rather than scheduler-delayed.",
			};
		},
	};
};
