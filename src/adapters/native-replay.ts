import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message, Model } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

import type { NativeHost } from "../types";

/** A replay document message as exposed by the benchmark corpus. */
export interface ReplayMessage {
	role: "user" | "assistant";
	content: string;
}

/** A genuine persisted rollout written through SessionManager. */
export interface ReplaySession {
	manager: SessionManager;
	sessionId: string;
	sessionFile: string;
	messages: AgentMessage[];
	baseTimestamp: number;
	messageCount: number;
}

/**
 * Parse a corpus timestamp for replay mtimes. The corpus timestamp is the only
 * supplied clock; session headers are created by the real process clock and are
 * not used by the native pipeline's age/idle filters.
 */
export function parseReplayTimestamp(value: string, context: string): number {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) {
		throw new Error(`invalid ${context} timestamp: ${JSON.stringify(value)}`);
	}
	return timestamp;
}

/** Filesystem-safe path segment for a corpus/project id. */
export function safeSegment(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
	return normalized || "item";
}

/**
 * Materialize a genuine native session file without touching the user's
 * terminal breadcrumb registry: SessionManager.open is given an explicit
 * session directory and `suppressBreadcrumb`.
 */
async function openIsolatedSession(cwd: string, sessionDir: string): Promise<{
	manager: SessionManager;
	sessionId: string;
	sessionFile: string;
}> {
	await fs.mkdir(sessionDir, { recursive: true });
	const sessionId = crypto.randomUUID();
	const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: path.resolve(cwd),
	};
	await Bun.write(sessionFile, `${JSON.stringify(header)}\n`);
	const manager = await SessionManager.open(sessionFile, sessionDir, new FileSessionStorage(), {
		suppressBreadcrumb: true,
		throwIfMissing: true,
	});
	return { manager, sessionId, sessionFile };
}

/** Create one persisted rollout per document and pin its mtime to the replay timestamp. */
export async function createReplaySession(options: {
	cwd: string;
	sessionDir: string;
	messages: readonly ReplayMessage[];
	model: Model;
	baseTimestamp: number;
}): Promise<ReplaySession> {
	if (options.messages.length === 0) throw new Error("cannot create an empty replay session");
	const { manager, sessionId, sessionFile } = await openIsolatedSession(options.cwd, options.sessionDir);
	const persisted: Message[] = [];
	options.messages.forEach((message, index) => {
		const timestamp = options.baseTimestamp + index;
		if (!message.content.trim()) return;
		const item: Message =
			message.role === "user"
				? { role: "user", content: message.content, timestamp }
				: {
						role: "assistant",
						content: [{ type: "text", text: message.content }],
						api: options.model.api,
						provider: options.model.provider,
						model: options.model.id,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						stopReason: "stop",
						timestamp,
					};
		manager.appendMessage(item);
		persisted.push(item);
	});
	await manager.flush();
	await manager.close();
	const replayDate = new Date(options.baseTimestamp);
	await fs.utimes(sessionFile, replayDate, replayDate);
	return {
		manager,
		sessionId,
		sessionFile,
		messages: persisted as AgentMessage[],
		baseTimestamp: options.baseTimestamp,
		messageCount: persisted.length,
	};
}

/** Create an empty persisted session used as the active host; it is excluded by thread id. */
export async function createActiveSession(
	cwd: string,
	sessionDir: string,
): Promise<{ manager: SessionManager; sessionId: string; sessionFile: string }> {
	const { manager, sessionId, sessionFile } = await openIsolatedSession(cwd, sessionDir);
	await manager.flush();
	await manager.close();
	return { manager, sessionId, sessionFile };
}

/**
 * Select the native model that the benchmark's gateway registered for
 * `context.model`. Never silently substitutes another provider.
 */
export function selectGatewayModel(host: NativeHost, configuredModel: string): Model {
	const bare = configuredModel.includes("/")
		? configuredModel.slice(configuredModel.indexOf("/") + 1)
		: configuredModel;
	const model = host.modelRegistry.find("memory-bench", bare);
	if (!model) throw new Error(`native host has no loopback benchmark model matching context.model=${configuredModel}`);
	return model;
}

export function modelSelector(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export interface NativeFileStat {
	path: string;
	bytes: number;
	lines: number;
	injected: boolean;
}

export interface NativeFileStats {
	root: string;
	files: NativeFileStat[];
	totalFiles: number;
	totalBytes: number;
	injectedFiles: number;
	injectedBytes: number;
}

/** Count every persisted memory artifact and mark only the ones the native prompt injects. */
export async function collectFileStats(
	root: string,
	injectedPaths: Readonly<Record<string, true>>,
): Promise<NativeFileStats> {
	const files: NativeFileStat[] = [];
	const walk = async (directory: string): Promise<void> => {
		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (!entry.isFile()) continue;
			let content: string;
			try {
				content = await Bun.file(fullPath).text();
			} catch {
				continue;
			}
			const relative = path.relative(root, fullPath).split(path.sep).join("/");
			const trimmed = content.trimEnd();
			files.push({
				path: relative,
				bytes: Buffer.byteLength(content),
				lines: trimmed ? trimmed.split(/\r?\n/).length : 0,
				injected: injectedPaths[relative] === true,
			});
		}
	};
	await walk(root);
	files.sort((a, b) => a.path.localeCompare(b.path));
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	const injected = files.filter(file => file.injected);
	return {
		root,
		files,
		totalFiles: files.length,
		totalBytes,
		injectedFiles: injected.length,
		injectedBytes: injected.reduce((sum, file) => sum + file.bytes, 0),
	};
}

export async function readTextIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await Bun.file(filePath).text();
	} catch {
		return undefined;
	}
}
