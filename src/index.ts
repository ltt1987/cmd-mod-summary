// summary — cross-session model token accounting for Command Code, backed by SQLite.
//
// Command Code reports no cumulative usage to the user, so this mod folds every
// `model_request_end` usage block into one row per (session, model) in
// ~/.commandcode/cmd-mod-summary/usage.db and exposes the totals through `/summary`.
//
// `usage.inputTokens` is the TOTAL prompt — cache read and cache write are SUBSETS of
// it, never siblings — so the ranking total is input + output. Adding all four fields
// would count the cached prefix twice.
//
// The time window filters rows by `updated_at` (the row's last activity), because rows
// are cumulative: a session active yesterday and today sums all of its tokens, not just
// today's share. The report says so rather than implying in-window precision.

import type {ModApi} from '@commandcode/harness';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {UsageDb, totalTokens, type ModelTotal, type UsageFilter} from './db.ts';

const RENDER_TYPE = 'cmd-summary/report';
const DEFAULT_TOP = 5;
const MAX_TOP = 50;
const DAY_MS = 86_400_000;

// Printed under every report, and reused verbatim when an argument is wrong, so the
// syntax is discoverable without a second command. Each line fits an 80-column
// terminal, whose feed leaves about 68 columns.
const LEGEND = [
	'usage: /summary [model=<pattern>] [days=<n>] [top=<n>]',
	'       [since=<YYYY-MM-DD>] [until=<YYYY-MM-DD>]',
	'       a bare word matches the model · default is top 5',
	'       /summary clear <filters> · clear all · asks to confirm',
];

const usageError = (problem: string) => `${problem}\n${LEGEND.join('\n')}`;

// The env override exists so the store can be pointed at a scratch file when testing.
const DB_PATH =
	process.env.CMD_SUMMARY_DB ?? join(homedir(), '.commandcode', 'cmd-mod-summary', 'usage.db');

const A = {
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	reset: '\x1b[0m',
} as const;

interface Totals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

interface Report {
	ansi: boolean;
	title: string;
	rows: ModelTotal[];
	grand: Totals & {models: number};
	scope: {
		models: number;
		sessions: number;
		entries: number;
		requests: number;
		first: string | null;
		last: string | null;
	};
	approximateWindow: boolean;
	databasePath: string;
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const UNITS = ['', 'k', 'M', 'B', 'T'] as const;

// Tiered on powers of 1000, which is how token counts are spoken about. Rounding can
// push the text into the next band, so the precision is re-derived from the rounded
// value: 9_999 becomes "10.0k" rather than "10.00k", and 999_999 becomes "1.00M"
// rather than "1000k".
function human(n: number): string {
	if (!Number.isFinite(n) || n < 1) return '0';
	if (n < 1000) return String(Math.round(n));
	let tier = Math.min(UNITS.length - 1, Math.floor(Math.log10(n) / 3));
	let scaled = n / 1000 ** tier;
	let digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
	for (;;) {
		const text = scaled.toFixed(digits);
		const rounded = Number(text);
		if (rounded >= 1000 && tier < UNITS.length - 1) {
			tier += 1;
			scaled = n / 1000 ** tier;
			digits = 2;
			continue;
		}
		if (rounded >= 100 && digits === 1) {
			digits = 0;
			continue;
		}
		if (rounded >= 10 && digits === 2) {
			digits = 1;
			continue;
		}
		return `${text}${UNITS[tier]}`;
	}
}

function paint(text: string, code: string, ansi: boolean): string {
	return ansi ? `${code}${text}${A.reset}` : text;
}

function stamp(iso: string | null, withYear: boolean): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	const mo = String(date.getMonth() + 1).padStart(2, '0');
	const dd = String(date.getDate()).padStart(2, '0');
	return withYear ? `${date.getFullYear()}-${mo}-${dd} ${hh}:${mm}` : `${mo}-${dd} ${hh}:${mm}`;
}

// `days=` and `since=` both lower the window; whichever appears last wins.
function parseDate(value: string, endOfDay: boolean): string | null {
	const day = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
	if (!day) {
		const fallback = new Date(value.trim());
		return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
	}
	const [, y, mo, d, hh = '0', mi = '0', ss = '0'] = day;
	const parsed = endOfDay
		? new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999)
		: new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss));
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseCount(value: string, max: number): number | null {
	const n = Number(value.trim());
	return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : null;
}

type Parsed =
	| {ok: true; filter: UsageFilter; top: number; clear: boolean; everything: boolean}
	| {ok: false; error: string};

function parseArgs(args: string): Parsed {
	const filter: UsageFilter = {};
	let top = DEFAULT_TOP;
	let clear = false;
	let everything = false;

	for (const token of args.trim().split(/\s+/).filter(Boolean)) {
		const at = token.indexOf('=');
		const key = at === -1 ? '' : token.slice(0, at).toLowerCase();
		const value = at === -1 ? token : token.slice(at + 1);
		if (!value) return {ok: false, error: usageError(`${token} needs a value.`)};

		// `clear` and `all` are subcommand words, not model patterns.
		if (!key && value.toLowerCase() === 'clear') {
			clear = true;
			continue;
		}
		if (clear && !key && value.toLowerCase() === 'all') {
			everything = true;
			continue;
		}

		switch (key) {
			// A bare token is the model pattern, so `/summary opus` reads like `/summary model=opus`.
			case '':
			case 'model':
			case 'm':
				filter.model = value;
				break;
			case 'since':
			case 'from': {
				const iso = parseDate(value, false);
				if (!iso) return {ok: false, error: usageError(`cannot read a date from "${value}".`)};
				filter.since = iso;
				break;
			}
			case 'until':
			case 'to': {
				const iso = parseDate(value, true);
				if (!iso) return {ok: false, error: usageError(`cannot read a date from "${value}".`)};
				filter.until = iso;
				break;
			}
			case 'days': {
				const n = parseCount(value, 36_500);
				if (n === null) return {ok: false, error: usageError('days= needs a positive number.')};
				filter.since = new Date(Date.now() - n * DAY_MS).toISOString();
				break;
			}
			case 'top':
			case 'limit': {
				const n = parseCount(value, MAX_TOP);
				if (n === null) return {ok: false, error: usageError('top= needs a positive number.')};
				top = n;
				break;
			}
			default:
				return {ok: false, error: usageError(`unknown option "${key}".`)};
		}
	}

	if (!clear) return {ok: true, filter, top, clear, everything};
	const scoped = Boolean(filter.model || filter.since || filter.until);
	// `all` means the whole store, so mixing it with a filter would be a guess.
	if (everything && scoped)
		return {ok: false, error: usageError('clear all takes no filters — drop "all" to clear a subset.')};
	if (!everything && !scoped)
		return {ok: false, error: usageError('clear needs "all" or at least one filter to select rows.')};
	return {ok: true, filter, top, clear, everything};
}

function describeQuery(filter: UsageFilter, top: number): string {
	const window = filter.since
		? filter.until
			? `${stamp(filter.since, false)} → ${stamp(filter.until, false)}`
			: `since ${stamp(filter.since, true)}`
		: filter.until
			? `until ${stamp(filter.until, true)}`
			: 'all time';
	const scope = filter.model ? `model ~ ${filter.model}` : 'all models';
	return `top ${top} · ${window} · ${scope}`;
}

function sum(rows: ModelTotal[]): Totals & {models: number} {
	const acc: Totals & {models: number} = {
		models: rows.length,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	};
	for (const row of rows) {
		acc.inputTokens += row.inputTokens;
		acc.outputTokens += row.outputTokens;
		acc.cacheReadTokens += row.cacheReadTokens;
		acc.cacheWriteTokens += row.cacheWriteTokens;
		acc.totalTokens += totalTokens(row);
	}
	return acc;
}

function buildReport(
	all: ModelTotal[],
	scope: ReturnType<UsageDb['scope']>,
	filter: UsageFilter,
	top: number,
	ansi: boolean,
): Report {
	return {
		ansi,
		title: describeQuery(filter, top),
		rows: all.slice(0, top),
		grand: sum(all),
		scope: {
			models: scope.models,
			sessions: scope.sessions,
			entries: scope.rows,
			requests: scope.requests,
			first: scope.firstSeenAt,
			last: scope.lastSeenAt,
		},
		approximateWindow: Boolean(filter.since || filter.until),
		databasePath: DB_PATH,
	};
}

interface Column {
	title: string;
	width: number;
	left: boolean;
}

// The feed draws its own chrome around each entry and wraps anything wider than what is
// left. The usable width is `columns - 12` at the pty sizes tried (80, 100 and 132), so
// that is the budget rather than a guess at the marker's exact cost.
const GUTTER = 12;
const INDENT = 2;
// Wide enough to hold a provider-qualified name such as `poolside/laguna-s-2.1-free`.
const MIN_MODEL = 26;

function columnsFor(rows: ModelTotal[], hideCacheWrite: boolean): Column[] {
	const token = (title: string, pick: (row: ModelTotal) => number): Column => ({
		title,
		width: Math.max(title.length, ...rows.map(row => human(pick(row)).length)),
		left: false,
	});
	const core: Column[] = [
		token('INPUT', row => row.inputTokens),
		token('OUTPUT', row => row.outputTokens),
		token('CACHE-R', row => row.cacheReadTokens),
		// Most providers never report a cache write, and an all-zero column is just
		// noise that steals room from the model name.
		...(hideCacheWrite ? [] : [token('CACHE-W', row => row.cacheWriteTokens)]),
		token('TOTAL', row => totalTokens(row)),
	];
	// Model identity outranks breadth and recency, so a narrow terminal drops LAST
	// first, then SESS, and starts clipping names only when nothing is left to drop.
	const rest: Column[] = [
		...core,
		{title: 'SESS', width: Math.max(4, ...rows.map(row => String(row.sessions).length)), left: false},
		{title: 'LAST', width: 11, left: false},
	];
	const room = () =>
		Math.max(56, (process.stdout.columns ?? 80) - GUTTER) -
		INDENT -
		rest.reduce((n, column) => n + column.width + 1, 0);
	while (room() < MIN_MODEL && rest.length > core.length) rest.pop();
	const longest = Math.max('MODEL'.length, ...rows.map(row => row.model.length));
	return [{title: 'MODEL', width: Math.max(MIN_MODEL, Math.min(longest, room())), left: true}, ...rest];
}

function clip(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function cell(value: string, column: Column, ansi: boolean): string {
	const text = clip(value, column.width);
	const pad = ' '.repeat(Math.max(0, column.width - text.length));
	const body = column.left ? `${text}${pad}` : `${pad}${text}`;
	return column.left ? paint(body, A.cyan, ansi) : body;
}

// Cells are keyed by column title, so whichever columns a narrow terminal sheds
// simply go unread instead of shifting the row sideways.
type CellSource = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	sessions: number;
};

function cellsFor(model: string, row: CellSource, lastUsedAt: string | null): Record<string, string> {
	return {
		MODEL: model,
		INPUT: human(row.inputTokens),
		OUTPUT: human(row.outputTokens),
		'CACHE-R': human(row.cacheReadTokens),
		'CACHE-W': human(row.cacheWriteTokens),
		TOTAL: human(totalTokens(row)),
		SESS: String(row.sessions),
		LAST: stamp(lastUsedAt, false),
	};
}

function one(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderReport(report: Report): string[] {
	const {ansi} = report;
	const indent = (text: string) => `  ${text}`;
	const heading = `${paint('⛁ cmd summary', A.bold + A.cyan, ansi)}  ${paint(report.title, A.dim, ansi)}`;

	if (report.rows.length === 0) {
		return [
			heading,
			indent(paint('nothing recorded for this query yet.', A.yellow, ansi)),
			indent(paint(`store: ${report.databasePath}`, A.dim, ansi)),
			...LEGEND.map((line, i) => indent(paint(line, i === 0 ? A.bold : A.dim, ansi))),
		];
	}

	// Judged on the whole matched scope: a model hidden below `top=` still keeps its
	// column alive.
	const columns = columnsFor(report.rows, report.grand.cacheWriteTokens === 0);
	const row = (values: Record<string, string>) =>
		indent(columns.map(column => cell(values[column.title] ?? '', column, ansi)).join(' '));
	const titles = Object.fromEntries(columns.map(column => [column.title, column.title]));
	const rule = indent(
		paint('─'.repeat(columns.reduce((n, column) => n + column.width + 1, 0) - 1), A.dim, ansi),
	);
	const {grand} = report;

	const lines = [
		heading,
		paint(row(titles), A.dim, ansi),
		rule,
		...report.rows.map(entry => row(cellsFor(entry.model, entry, entry.lastUsedAt))),
		rule,
		row(cellsFor('ALL', {...grand, sessions: report.scope.sessions}, report.scope.last)),
	];

	const hidden = grand.models - report.rows.length;
	const foot = (text: string, code = A.dim) => indent(paint(text, code, ansi));
	lines.push(
		foot(
			`${one(grand.models, 'model')} · ${one(report.scope.sessions, 'session')} · ${one(report.scope.entries, 'row')} · ${one(report.scope.requests, 'request')}` +
				(hidden > 0 ? ` · top ${report.rows.length} shown` : ''),
		),
	);
	lines.push(foot(`first recorded ${stamp(report.scope.first, true)} · last used ${stamp(report.scope.last, true)}`));
	lines.push(foot('TOTAL = input + output · cache is inside input · units k/M/B/T'));
	if (report.approximateWindow) {
		lines.push(foot('! cumulative rows: sessions in range sum all their tokens', A.yellow));
	}
	lines.push(...LEGEND.map((line, i) => foot(line, i === 0 ? A.bold : A.dim)));
	return lines;
}

export default async function (cmd: ModApi): Promise<void> {
	let db: UsageDb | null = null;
	let sessionId = '';
	let warnedAboutWrites = false;

	try {
		db = await UsageDb.open(DB_PATH);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		cmd.ui.notify(`summary: cannot open ${DB_PATH} — ${reason}; usage will not be recorded`);
	}

	cmd.on('run_start', event => {
		if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId;
	});

	cmd.on('model_request_end', event => {
		if (!db) return;
		const usage = (event.usage ?? {}) as Record<string, unknown>;
		const delta = {
			inputTokens: num(usage.inputTokens),
			outputTokens: num(usage.outputTokens),
			cacheReadTokens: num(usage.cacheReadTokens),
			cacheWriteTokens: num(usage.cacheWriteTokens),
		};
		if (!sessionId || totalTokens(delta) === 0) return;

		try {
			db.record({
				sessionId,
				model: typeof event.model === 'string' && event.model ? event.model : 'unknown',
				...delta,
				at: new Date().toISOString(),
			});
		} catch (error) {
			if (warnedAboutWrites) return;
			warnedAboutWrites = true;
			const reason = error instanceof Error ? error.message : String(error);
			cmd.ui.notify(`summary: failed to record usage — ${reason}`);
		}
	});

	cmd.addRenderer(RENDER_TYPE, data => renderReport(data as Report));

	// Deletion is irreversible, so every path here ends on the TUI's confirm modal.
	// Headless runs resolve `confirm` to false, which is the safe answer.
	const clearUsage = async (
		store: UsageDb,
		filter: UsageFilter,
		everything: boolean,
		ansi: boolean,
	): Promise<{message: string}> => {
		const scope: UsageFilter = everything ? {} : filter;
		const matched = store.scope(scope);
		if (matched.rows === 0) return {message: 'summary: nothing matches, so there is nothing to delete.'};

		let preview = '';
		if (!everything) {
			const totals = store.totalsByModel(scope);
			const report = buildReport(totals, matched, scope, Math.min(totals.length, MAX_TOP), ansi);
			// The report is the preview: exactly the rows about to be deleted, unpaginated.
			if (ansi) cmd.showEntry(RENDER_TYPE, report);
			else preview = `${renderReport({...report, ansi: false}).join('\n')}\n`;
		}
		const counts = `${one(matched.rows, 'row')} · ${one(matched.models, 'model')} · ${one(matched.sessions, 'session')} in ${DB_PATH}`;
		const confirmed = await cmd.ui.confirm({
			title: everything ? 'Delete ALL recorded usage?' : 'Delete the usage above?',
			message: `${counts} — this cannot be undone.`,
		});
		if (!confirmed)
			return {
				message:
					preview +
					(ansi
						? 'summary: nothing deleted.'
						: 'summary: clearing needs an interactive session to confirm — nothing deleted.'),
			};

		const gone = store.purge(scope);
		return {
			message: `summary: deleted ${one(gone.rows, 'row')} · ${one(gone.models, 'model')} · ${one(gone.sessions, 'session')}.`,
		};
	};

	cmd.addCommand({
		name: 'summary',
		description: 'Token usage per model across every cmd session; `clear` deletes rows',
		argumentHint: '[model=<pattern>] [since=<date>] [until=<date>] [days=<n>] [top=<n>] | clear [all]',
		handler: async ({args}) => {
			if (!db) return {message: 'summary: the SQLite store is unavailable, so there is nothing to report.'};
			const parsed = parseArgs(String(args ?? ''));
			if (!parsed.ok) return {message: parsed.error};

			const {filter, top, clear, everything} = parsed;
			// Footer status is an interactive-TUI surface; headless runs drop showEntry,
			// so those get an unstyled info row from the same renderer instead.
			const ansi = Boolean(cmd.ui.capabilities.status);
			if (clear) return clearUsage(db, filter, everything, ansi);

			const report = buildReport(db.totalsByModel(filter), db.scope(filter), filter, top, ansi);

			if (ansi) {
				cmd.showEntry(RENDER_TYPE, report);
				return undefined;
			}
			return {message: renderReport({...report, ansi: false}).join('\n')};
		},
	});
}
