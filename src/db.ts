// SQLite store for per-session, per-model token usage.
//
// One row per (session_id, model): a session that switches models grows a second row,
// and every model request folds its usage into the matching row. `node:sqlite` is
// imported lazily so an older runtime degrades to a readable notice instead of taking
// the whole mod down at import time.

import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

type Statement = {
	run(...params: unknown[]): unknown;
	all(...params: unknown[]): Record<string, unknown>[];
};

type SqliteDb = {
	exec(sql: string): void;
	prepare(sql: string): Statement;
};

export interface UsageDelta {
	sessionId: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** ISO-8601 UTC timestamp of the request. */
	at: string;
}

export interface UsageFilter {
	/** Substring match against the model name. */
	model?: string;
	/** ISO-8601 UTC lower bound, compared against `updated_at`. */
	since?: string;
	/** ISO-8601 UTC upper bound, compared against `updated_at`. */
	until?: string;
}

export interface ModelTotal {
	model: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	sessions: number;
	lastUsedAt: string;
}

export interface ScopeTotal {
	models: number;
	sessions: number;
	rows: number;
	requests: number;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
}

/** What one `purge()` actually removed, counted from the rows it deleted. */
export interface Purged {
	rows: number;
	models: number;
	sessions: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS token_usage (
	session_id          TEXT    NOT NULL,
	model               TEXT    NOT NULL,
	input_tokens        INTEGER NOT NULL DEFAULT 0,
	output_tokens       INTEGER NOT NULL DEFAULT 0,
	cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
	cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
	requests            INTEGER NOT NULL DEFAULT 0,
	created_at          TEXT    NOT NULL,
	updated_at          TEXT    NOT NULL,
	PRIMARY KEY (session_id, model)
);
CREATE INDEX IF NOT EXISTS token_usage_updated_at ON token_usage (updated_at);
`;

const UPSERT = `
INSERT INTO token_usage (
	session_id, model, input_tokens, output_tokens,
	cache_read_tokens, cache_write_tokens, requests, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT (session_id, model) DO UPDATE SET
	input_tokens       = input_tokens       + excluded.input_tokens,
	output_tokens      = output_tokens      + excluded.output_tokens,
	cache_read_tokens  = cache_read_tokens  + excluded.cache_read_tokens,
	cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
	requests           = requests           + excluded.requests,
	updated_at         = excluded.updated_at
`;

// `instr` is a plain substring test, so a fuzzy model query never has to escape LIKE's
// % and _ wildcards. Total tokens are `input + output`: the provider reports
// `input_tokens` as the WHOLE prompt, with cache read/write as subsets of it, so
// summing all four would count the cached prefix twice.
const SELECT_BY_MODEL = `
SELECT
	model,
	SUM(input_tokens)        AS input_tokens,
	SUM(output_tokens)       AS output_tokens,
	SUM(cache_read_tokens)   AS cache_read_tokens,
	SUM(cache_write_tokens)  AS cache_write_tokens,
	COUNT(DISTINCT session_id) AS sessions,
	MAX(updated_at)          AS last_used_at
FROM token_usage
WHERE (? IS NULL OR instr(model, ?) > 0)
	AND (? IS NULL OR updated_at >= ?)
	AND (? IS NULL OR updated_at <= ?)
GROUP BY model
`;

const SELECT_SCOPE = `
SELECT
	COUNT(DISTINCT model)    AS models,
	COUNT(DISTINCT session_id) AS sessions,
	COUNT(*)                 AS rows_count,
	SUM(requests)            AS requests,
	MIN(created_at)          AS first_seen_at,
	MAX(updated_at)          AS last_seen_at
FROM token_usage
WHERE (? IS NULL OR instr(model, ?) > 0)
	AND (? IS NULL OR updated_at >= ?)
	AND (? IS NULL OR updated_at <= ?)
`;

// `RETURNING` makes the deleted set observable in the same statement, so the count the
// user is told about is the count that actually went away — no read-then-delete race
// between concurrent sessions.
const DELETE_MATCHING = `
DELETE FROM token_usage
WHERE (? IS NULL OR instr(model, ?) > 0)
	AND (? IS NULL OR updated_at >= ?)
	AND (? IS NULL OR updated_at <= ?)
RETURNING session_id, model
`;

function int(value: unknown): number {
	// node:sqlite hands back a BigInt past Number.MAX_SAFE_INTEGER; token totals never get there.
	return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

function nullableStr(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

// Every filter reads each bound value twice: once for the `IS NULL` test, once for the
// comparison next to it.
function filterParams(filter: UsageFilter): unknown[] {
	const {model, since, until} = filter;
	return [model, model, since, since, until, until].map(value => value ?? null);
}

export class UsageDb {
	private readonly db: SqliteDb;
	private readonly upsert: Statement;

	private constructor(db: SqliteDb) {
		this.db = db;
		this.upsert = db.prepare(UPSERT);
	}

	static async open(filePath: string): Promise<UsageDb> {
		const {DatabaseSync} = (await import('node:sqlite')) as {
			DatabaseSync: new (path: string) => SqliteDb;
		};
		mkdirSync(dirname(filePath), {recursive: true});
		const db = new DatabaseSync(filePath);
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA busy_timeout = 2000');
		db.exec(SCHEMA);
		return new UsageDb(db);
	}

	record(delta: UsageDelta): void {
		this.upsert.run(
			delta.sessionId,
			delta.model,
			delta.inputTokens,
			delta.outputTokens,
			delta.cacheReadTokens,
			delta.cacheWriteTokens,
			delta.at,
			delta.at,
		);
	}

	totalsByModel(filter: UsageFilter): ModelTotal[] {
		return this.db
			.prepare(SELECT_BY_MODEL)
			.all(...filterParams(filter))
			.map(row => ({
				model: str(row.model),
				inputTokens: int(row.input_tokens),
				outputTokens: int(row.output_tokens),
				cacheReadTokens: int(row.cache_read_tokens),
				cacheWriteTokens: int(row.cache_write_tokens),
				sessions: int(row.sessions),
				lastUsedAt: str(row.last_used_at),
			}))
			.sort((a, b) => totalTokens(b) - totalTokens(a) || a.model.localeCompare(b.model));
	}

	scope(filter: UsageFilter): ScopeTotal {
		const row = this.db.prepare(SELECT_SCOPE).all(...filterParams(filter))[0];
		return {
			models: int(row?.models),
			sessions: int(row?.sessions),
			rows: int(row?.rows_count),
			requests: int(row?.requests),
			firstSeenAt: nullableStr(row?.first_seen_at),
			lastSeenAt: nullableStr(row?.last_seen_at),
		};
	}

	/** Physically deletes every row the filter selects. There is no undo and no archive. */
	purge(filter: UsageFilter): Purged {
		const rows = this.db.prepare(DELETE_MATCHING).all(...filterParams(filter));
		return {
			rows: rows.length,
			models: new Set(rows.map(row => str(row.model))).size,
			sessions: new Set(rows.map(row => str(row.session_id))).size,
		};
	}
}

export function totalTokens(row: {inputTokens: number; outputTokens: number}): number {
	return row.inputTokens + row.outputTokens;
}
