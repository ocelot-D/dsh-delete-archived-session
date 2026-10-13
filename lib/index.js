/**
 * DSH plugin: list and delete archived sessions.
 *
 * DSH ships only `archiveSession` / `unarchiveSession`: archiving hides a
 * session, and its log stays on disk forever. This plugin adds the missing
 * destructive half — inspect the archive set, then move those logs to a trash
 * folder (default) or purge them for real.
 *
 * Safety rules, all enforced here:
 *  - only ids currently in `workspaceRegistry.archivedSessionIds` are eligible;
 *  - a delete requires `confirm: true` and at least one explicit id;
 *  - the directory must prove ownership (its log's first record carries the id);
 *  - nothing is ever touched outside the resolved sessions root;
 *  - the default action is a reversible move to trash.
 *
 * @module dsh-plugin-delete-archived-session
 */

import { join } from 'node:path';
import {
	assertInside,
	inspectSession,
	purgeSessionDir,
	resolveSessionsRoot,
	trashSessionDir,
} from './session-store.js';

/** Cordis plugin identity. */
export const name = 'tool-delete-archived-session';

/**
 * No `inject`. Cordis treats an inject entry as a REQUIRED dependency, and the
 * tool and command registries are separate optional services: a profile may
 * mount `tools` without `commands` (or vice versa). Declaring either would make
 * the whole plugin fail to mount in such a profile, so each surface is
 * registered inside its own `ctx.inject([...])` block and simply stays absent
 * where its registry is. The workspace registry is resolved lazily at call time
 * for the same reason.
 */
export const inject = [];

/**
 * This plugin deliberately imports nothing outside Node's standard library: it
 * registers plain tool/command descriptors instead of `defineTool`, and takes
 * no schemastery `Config`, so it cannot fail to mount over a dependency that a
 * profile happens to hoist differently. Overrides come from the environment:
 *
 *   DSH_DELETE_ARCHIVED_SESSIONS_ROOT   - sessions root (default `$DSH_HOME/sessions`)
 *   DSH_DELETE_ARCHIVED_SESSIONS_TRASH  - trash directory (default `<root>/../.deleted-sessions`)
 *   DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT=false - refuse permanent deletion
 */
const ENV_ROOT = 'DSH_DELETE_ARCHIVED_SESSIONS_ROOT';
const ENV_TRASH = 'DSH_DELETE_ARCHIVED_SESSIONS_TRASH';
const ENV_PERMANENT = 'DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT';

/** Resolve the archived session ids, or throw a readable configuration error. */
function archivedIds(ctx) {
	const registry = ctx.get('workspaceRegistry');
	if (registry === undefined) throw new Error('workspaceRegistry is not mounted in this profile; archived sessions cannot be listed');
	return [...registry.archivedSessionIds];
}

/** Human-readable byte count. */
function humanBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

/** Build the effective runtime settings from plugin config and the environment. */
function settings(config) {
	const configuredRoot = config?.sessionsRoot ?? process.env[ENV_ROOT];
	const sessionsRoot = resolveSessionsRoot(configuredRoot, config?.dshHome);
	const configuredTrash = config?.trashDir ?? process.env[ENV_TRASH];
	const trashDir = configuredTrash !== undefined && configuredTrash.trim().length > 0
		? configuredTrash
		: join(sessionsRoot, '..', '.deleted-sessions');
	const permanentEnv = config?.allowPermanent === undefined ? process.env[ENV_PERMANENT] : undefined;
	const allowPermanent = config?.allowPermanent !== false && !/^(?:0|false|no)$/iu.test(permanentEnv ?? '');
	return { sessionsRoot, trashDir, allowPermanent };
}

/**
 * List archived sessions with the on-disk facts needed to decide about them.
 * @param root - sessions root.
 * @param ids - archived session ids.
 * @returns one row per archived session, including ids with no stored log.
 */
async function describeArchived(root, ids) {
	const rows = [];
	for (const sessionId of ids) {
		try {
			const info = await inspectSession(root, sessionId);
			if (info === undefined) {
				rows.push({ sessionId, stored: false });
				continue;
			}
			const createdAt = typeof info.header.createdAt === 'number' ? new Date(info.header.createdAt).toISOString() : undefined;
			rows.push({
				sessionId,
				stored: true,
				dir: info.dir,
				bytes: info.bytes,
				createdAt,
				title: typeof info.header.title === 'string' ? info.header.title : undefined,
				cwd: typeof info.header.cwd === 'string' ? info.header.cwd : undefined,
				artifacts: info.artifacts.length,
			});
		} catch (error) {
			rows.push({ sessionId, stored: false, error: error.message });
		}
	}
	return rows;
}

/** Render the listing as direct UI text. */
function renderList(rows, root) {
	if (rows.length === 0) return { kind: 'success', text: `No archived sessions. (sessions root: ${root})` };
	const lines = [`Archived sessions (${rows.length}) — root: ${root}`, ''];
	for (const row of rows) {
		if (!row.stored) {
			lines.push(`- ${row.sessionId}${row.error ? `  [unreadable: ${row.error}]` : '  [no stored log]'}`);
			continue;
		}
		const when = row.createdAt !== undefined ? `  ${row.createdAt}` : '';
		const size = `  ${humanBytes(row.bytes)}`;
		const title = row.title !== undefined ? `  "${row.title}"` : '';
		lines.push(`- ${row.sessionId}${title}${when}${size}`);
	}
	lines.push('', 'Delete with: /delete-archived delete <sessionId...> --yes [--permanent]');
	return { kind: 'success', text: lines.join('\n') };
}

/**
 * Delete archived sessions.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 * @param sessionIds - explicit ids to delete.
 * @param permanent - purge instead of moving to trash.
 * @returns per-id outcome rows.
 */
async function deleteArchived(ctx, config, sessionIds, permanent) {
	const { sessionsRoot, trashDir, allowPermanent } = settings(config);
	const archived = new Set(archivedIds(ctx));
	const registry = ctx.get('workspaceRegistry');
	const results = [];

	for (const sessionId of sessionIds) {
		const row = { sessionId };
		try {
			if (!archived.has(sessionId)) {
				row.outcome = 'refused';
				row.reason = 'not an archived session';
				results.push(row);
				continue;
			}
			if (permanent && !allowPermanent) {
				row.outcome = 'refused';
				row.reason = 'permanent deletion is disabled by plugin config';
				results.push(row);
				continue;
			}
			const info = await inspectSession(sessionsRoot, sessionId);
			if (info === undefined) {
				// Nothing on disk: drop the stale archive entry so the UI stops listing it.
				await registry.unarchiveSession(sessionId);
				row.outcome = 'no-stored-log';
				row.reason = 'no stored log was found; the stale archive entry was cleared';
				results.push(row);
				continue;
			}
			assertInside(sessionsRoot, info.dir);
			if (permanent) {
				row.artifacts = await purgeSessionDir(info.dir);
				row.outcome = 'purged';
			} else {
				row.movedTo = await trashSessionDir(info.dir, trashDir);
				row.outcome = 'trashed';
			}
			row.bytes = info.bytes;
			await registry.unarchiveSession(sessionId);
			results.push(row);
		} catch (error) {
			row.outcome = 'failed';
			row.reason = error.message;
			results.push(row);
		}
	}
	return { rows: results, trashDir, sessionsRoot };
}

/** Render deletion outcomes as direct UI text. */
function renderDelete(report) {
	const lines = [];
	const gone = report.rows.filter((row) => row.outcome === 'trashed' || row.outcome === 'purged');
	if (gone.length === 0) lines.push('Nothing was deleted.');
	else {
		const verb = gone.every((row) => row.outcome === 'purged') ? 'Permanently deleted' : 'Deleted';
		lines.push(`${verb} ${gone.length} archived session(s).`);
	}
	for (const row of report.rows) {
		switch (row.outcome) {
			case 'trashed':
				lines.push(`- ${row.sessionId}: moved to ${row.movedTo} (${humanBytes(row.bytes ?? 0)})`);
				break;
			case 'purged':
				lines.push(`- ${row.sessionId}: permanently removed (${humanBytes(row.bytes ?? 0)})`);
				break;
			case 'no-stored-log':
				lines.push(`- ${row.sessionId}: nothing on disk; archive entry cleared`);
				break;
			case 'refused':
				lines.push(`- ${row.sessionId}: refused — ${row.reason}`);
				break;
			default:
				lines.push(`- ${row.sessionId}: failed — ${row.reason}`);
		}
	}
	if (report.rows.some((row) => row.outcome === 'trashed')) {
		lines.push('', `Trashed sessions keep their original project/session folder names under: ${report.trashDir}`);
		lines.push('To restore one, move its folder back into the sessions root at the same relative path.');
	}
	const failed = report.rows.filter((row) => row.outcome === 'failed');
	return { kind: failed.length > 0 ? 'error' : 'success', text: lines.join('\n') };
}

/**
 * Parse the `/delete-archived` grammar: `list`, or `delete <id...> --yes [--permanent]`.
 * @param raw - the command's input line.
 * @returns the parsed request.
 */
function parseCommand(raw) {
	const tokens = raw.trim().split(/\s+/u).filter((token) => token.length > 0);
	const head = (tokens.shift() ?? '').toLowerCase();
	if (head === '' || head === 'list') return { action: 'list' };
	if (head !== 'delete') return { action: 'invalid', reason: `unknown subcommand "${head}"` };
	const permanent = tokens.includes('--permanent');
	const confirmed = tokens.includes('--yes');
	const sessionIds = tokens.filter((token) => !token.startsWith('--'));
	if (sessionIds.length === 0) return { action: 'invalid', reason: 'delete requires at least one session id' };
	if (!confirmed) return { action: 'unconfirmed', sessionIds, permanent };
	return { action: 'delete', sessionIds, permanent };
}

/**
 * Register the tool and the slash command.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
	const { sessionsRoot } = settings(config);

	ctx.inject(['tools'], (toolCtx) => {
		toolCtx.tools.register({
		name: 'delete_archived_sessions',
		description: [
			'List or delete archived DSH sessions.',
			'DSH archiving only hides a session; its log stays on disk. This tool removes that log.',
			'action="list" reports every archived session with its id, creation time, and size.',
			'action="delete" requires explicit sessionIds and confirm=true, and by default MOVES the session folder into a trash directory so the deletion is reversible; pass permanent=true to unlink it instead.',
			'Only sessions currently in the archive set are eligible; every directory must prove ownership by its own log header before it is touched.',
		].join(' '),
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['list', 'delete'], description: 'Whether to list archived sessions or delete them.' },
				sessionIds: { type: 'array', items: { type: 'string' }, description: 'Exact archived session ids to delete. Required for action="delete".' },
				confirm: { type: 'boolean', description: 'Must be true to actually delete; protects against accidental invocation.' },
				permanent: { type: 'boolean', description: 'Delete for real instead of moving to the trash directory. Defaults to false.' },
			},
			required: ['action'],
			additionalProperties: false,
		},
		output: {
			// Real JSON Schema, not the schemastery author-spec that `defineTool`
			// would compile: `tools.register()` validates this against its enforced
			// subset directly, and the enforced subset requires `required` to be an
			// array of property names.
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string' },
					sessionsRoot: { type: 'string' },
					trashDir: { type: 'string' },
					archived: { type: 'array', items: { type: 'object' } },
					results: { type: 'array', items: { type: 'object' } },
				},
				required: ['action', 'sessionsRoot', 'archived', 'results'],
			},
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, void 0, 2) }],
		},
		execute: async (args) => {
			if (args.action === 'list') {
				const ids = archivedIds(ctx);
				const archived = await describeArchived(sessionsRoot, ids);
				return { action: 'list', sessionsRoot, trashDir: settings(config).trashDir, archived, results: [] };
			}
			if (args.confirm !== true) throw new Error('delete requires confirm:true; run action="list" first and pass the exact sessionIds');
			const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds : [];
			if (sessionIds.length === 0) throw new Error('delete requires at least one sessionId');
			const report = await deleteArchived(ctx, config, sessionIds, args.permanent === true);
			return {
				action: 'delete',
				sessionsRoot: report.sessionsRoot,
				trashDir: report.trashDir,
				archived: [],
				results: report.rows,
			};
		},
		presentCall: (args) => ({
			card: 'generic',
			title: args.action === 'delete' ? 'Delete archived sessions' : 'List archived sessions',
			kind: args.action === 'delete' ? 'write' : 'read',
		}),
		});
	});

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: 'delete-archived',
			description: 'List archived sessions, or delete them (/delete-archived delete <id...> --yes [--permanent])',
			input: { hint: '[list | delete <sessionId...> --yes [--permanent]]' },
			handler: async (invocation) => {
				const parsed = parseCommand(invocation.line ?? '');
				switch (parsed.action) {
					case 'list': {
						const ids = archivedIds(ctx);
						return renderList(await describeArchived(sessionsRoot, ids), sessionsRoot);
					}
					case 'invalid':
						return { kind: 'error', text: `${parsed.reason}\nUsage: /delete-archived [list | delete <sessionId...> --yes [--permanent]]` };
					case 'unconfirmed':
						return {
							kind: 'error',
							text: [
								`Refusing to delete ${parsed.sessionIds.length} session(s) without confirmation.`,
								`This is irreversible for the log files${parsed.permanent ? ' (permanent mode)' : ' (they are moved to the trash directory)'}.`,
								'',
								`Re-run with --yes: /delete-archived delete ${parsed.sessionIds.join(' ')} --yes${parsed.permanent ? ' --permanent' : ''}`,
							].join('\n'),
						};
					case 'delete': {
						const report = await deleteArchived(ctx, config, parsed.sessionIds, parsed.permanent);
						return renderDelete(report);
					}
					default:
						return { kind: 'error', text: 'unsupported request' };
				}
			},
		});
	});
}

export default { name, inject, apply };
