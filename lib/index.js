/**
 * DSH 插件：列出并删除已归档的会话。
 *
 * DSH 本身只提供 `archiveSession` / `unarchiveSession`：归档只是把会话藏起来，
 * 日志永远留在磁盘上。本插件补上缺失的那一半——查看归档列表，然后把日志
 * 移入回收站（默认，可恢复）或彻底删除。
 *
 * 安全规则，全部在这里强制执行：
 *  - 只有当前在 `workspaceRegistry.archivedSessionIds` 里的会话才可操作；
 *  - 删除必须带 `confirm: true` 且至少给出一个明确的会话 ID；
 *  - 目录必须能自证归属（日志首行的 id 必须匹配）；
 *  - 绝不触碰解析出的会话根目录之外的任何路径；
 *  - 默认动作是移入回收站，可恢复。
 *
 * 注意：所有面向用户的文字都是中文；工具名、`action` 取值、`--yes` /
 * `--permanent` 这类参数属于接口，保持英文不变。
 *
 * @module dsh-delete-archived-session
 */

import { join } from 'node:path';
import {
	assertInside,
	inspectSession,
	purgeSessionDir,
	resolveSessionsRoot,
	trashSessionDir,
} from './session-store.js';

/** Cordis 插件标识。 */
export const name = 'delete-archived-session';

/**
 * 不声明 `inject`。Cordis 把 inject 里的每一项都当作**必需**依赖，而工具注册表
 * 和命令注册表是两个各自独立、可有可无的服务：某个 profile 可能只挂了 `tools`
 * 而没有 `commands`（反之亦然）。只要声明其中任一个，插件在这种 profile 里就
 * 整体挂载失败。所以每个入口都放进自己的 `ctx.inject([...])` 里单独注册，哪个
 * 注册表不在，就只缺那一个入口。`workspaceRegistry` 同理，在调用时才惰性取。
 */
export const inject = [];

/**
 * 本插件刻意不导入 Node 标准库以外的任何东西：它注册的是朴素的工具/命令描述
 * 对象，而不是 `defineTool`，也不接受 schemastery `Config`，因此不会因为某个
 * profile 对 DSH 自身依赖的提升方式不同而挂载失败。配置改从环境变量读取：
 *
 *   DSH_DELETE_ARCHIVED_SESSIONS_ROOT   - 会话根目录（默认 `$DSH_HOME/sessions`）
 *   DSH_DELETE_ARCHIVED_SESSIONS_TRASH  - 回收站目录（默认 `<根目录>/../.deleted-sessions`）
 *   DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT=false - 禁止永久删除
 */
const ENV_ROOT = 'DSH_DELETE_ARCHIVED_SESSIONS_ROOT';
const ENV_TRASH = 'DSH_DELETE_ARCHIVED_SESSIONS_TRASH';
const ENV_PERMANENT = 'DSH_DELETE_ARCHIVED_SESSIONS_PERMANENT';

/** 取归档会话 ID 列表；取不到时抛一个能看懂的错误。 */
function archivedIds(ctx) {
	const registry = ctx.get('workspaceRegistry');
	if (registry === undefined) throw new Error('当前 profile 没有挂载 workspaceRegistry，无法列出归档会话');
	return [...registry.archivedSessionIds];
}

/** 把字节数变成人能读的大小。 */
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

/** 由插件配置和环境变量算出实际生效的设置。 */
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
 * 列出归档会话，附带判断时需要知道的磁盘信息。
 * @param root - 会话根目录。
 * @param ids - 归档会话 ID。
 * @returns 每个归档会话一行，包含磁盘上没有日志的那些。
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

/** 把列表渲染成直接显示在界面上的文本。 */
function renderList(rows, root) {
	if (rows.length === 0) return { kind: 'success', text: `没有已归档的会话。（会话根目录：${root}）` };
	const lines = [`已归档的会话（共 ${rows.length} 个）— 根目录：${root}`, ''];
	for (const row of rows) {
		if (!row.stored) {
			lines.push(`- ${row.sessionId}${row.error ? `  [读取失败：${row.error}]` : '  [磁盘上没有日志]'}`);
			continue;
		}
		const when = row.createdAt !== undefined ? `  ${row.createdAt}` : '';
		const size = `  ${humanBytes(row.bytes)}`;
		const title = row.title !== undefined ? `  「${row.title}」` : '';
		lines.push(`- ${row.sessionId}${title}${when}${size}`);
	}
	lines.push('', '删除命令：/delete-archived delete <会话ID...> --yes [--permanent]');
	return { kind: 'success', text: lines.join('\n') };
}

/**
 * 删除归档会话。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 * @param sessionIds - 明确指定要删除的会话 ID。
 * @param permanent - 为真时彻底删除，否则移入回收站。
 * @returns 每个 ID 的处理结果。
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
				row.reason = '它不是已归档的会话';
				results.push(row);
				continue;
			}
			if (permanent && !allowPermanent) {
				row.outcome = 'refused';
				row.reason = '插件配置里已禁用永久删除';
				results.push(row);
				continue;
			}
			const info = await inspectSession(sessionsRoot, sessionId);
			if (info === undefined) {
				// 磁盘上什么都没有：把这条残留的归档记录清掉，免得界面一直列着它。
				await registry.unarchiveSession(sessionId);
				row.outcome = 'no-stored-log';
				row.reason = '磁盘上没找到日志，已清除残留的归档记录';
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

/** 把删除结果渲染成直接显示在界面上的文本。 */
function renderDelete(report) {
	const lines = [];
	const gone = report.rows.filter((row) => row.outcome === 'trashed' || row.outcome === 'purged');
	if (gone.length === 0) lines.push('没有删除任何内容。');
	else {
		const verb = gone.every((row) => row.outcome === 'purged') ? '已彻底删除' : '已删除';
		lines.push(`${verb} ${gone.length} 个归档会话。`);
	}
	for (const row of report.rows) {
		switch (row.outcome) {
			case 'trashed':
				lines.push(`- ${row.sessionId}：已移入回收站 ${row.movedTo}（${humanBytes(row.bytes ?? 0)}）`);
				break;
			case 'purged':
				lines.push(`- ${row.sessionId}：已彻底删除（${humanBytes(row.bytes ?? 0)}）`);
				break;
			case 'no-stored-log':
				lines.push(`- ${row.sessionId}：磁盘上没有内容，已清除归档记录`);
				break;
			case 'refused':
				lines.push(`- ${row.sessionId}：已拒绝 — ${row.reason}`);
				break;
			default:
				lines.push(`- ${row.sessionId}：失败 — ${row.reason}`);
		}
	}
	if (report.rows.some((row) => row.outcome === 'trashed')) {
		lines.push('', `回收站里的会话保留了原有的「项目目录/会话目录」名，位置：${report.trashDir}`);
		lines.push('要恢复，把对应文件夹按原路径移回会话根目录即可。');
	}
	const failed = report.rows.filter((row) => row.outcome === 'failed');
	return { kind: failed.length > 0 ? 'error' : 'success', text: lines.join('\n') };
}

/**
 * 解析 `/delete-archived` 的语法：`list`，或 `delete <ID...> --yes [--permanent]`。
 * @param raw - 命令后面的那串输入。
 * @returns 解析结果。
 */
function parseCommand(raw) {
	const tokens = raw.trim().split(/\s+/u).filter((token) => token.length > 0);
	const head = (tokens.shift() ?? '').toLowerCase();
	if (head === '' || head === 'list') return { action: 'list' };
	if (head !== 'delete') return { action: 'invalid', reason: `未知子命令「${head}」` };
	const permanent = tokens.includes('--permanent');
	const confirmed = tokens.includes('--yes');
	const sessionIds = tokens.filter((token) => !token.startsWith('--'));
	if (sessionIds.length === 0) return { action: 'invalid', reason: 'delete 至少要给出一个会话 ID' };
	if (!confirmed) return { action: 'unconfirmed', sessionIds, permanent };
	return { action: 'delete', sessionIds, permanent };
}

/**
 * 注册工具和斜杠命令。
 * @param ctx - 插件上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config) {
	const { sessionsRoot } = settings(config);

	ctx.inject(['tools'], (toolCtx) => {
		toolCtx.tools.register({
			name: 'delete_archived_sessions',
			description: [
				'列出或删除 DSH 的已归档会话。',
				'DSH 的归档只是把会话藏起来，日志仍留在磁盘上；本工具负责删掉那份日志。',
				'action="list" 列出每个归档会话的 ID、创建时间和占用大小。',
				'action="delete" 必须给出明确的 sessionIds 且 confirm=true；默认把会话目录移入回收站，删除可恢复，传 permanent=true 才会真正删掉。',
				'只有当前在归档集合里的会话才可操作；每个目录都必须先由它自己的日志首行证明归属，才会被触碰。',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: ['list', 'delete'], description: '列出归档会话，还是删除它们。' },
					sessionIds: { type: 'array', items: { type: 'string' }, description: '要删除的归档会话 ID，必须完全匹配。action="delete" 时必填。' },
					confirm: { type: 'boolean', description: '必须为 true 才会真正删除，用来防止误调用。' },
					permanent: { type: 'boolean', description: '为 true 则彻底删除，而不是移入回收站。默认 false。' },
				},
				required: ['action'],
				additionalProperties: false,
			},
			output: {
				// 这里是真正的 JSON Schema，不是 `defineTool` 会去编译的 schemastery
				// 作者写法：`tools.register()` 会直接拿它跑自身的校验子集，而该子集
				// 要求 `required` 必须是属性名数组。
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
				if (args.confirm !== true) throw new Error('删除需要 confirm:true；请先执行 action="list"，再带上完全匹配的 sessionIds');
				const sessionIds = Array.isArray(args.sessionIds) ? args.sessionIds : [];
				if (sessionIds.length === 0) throw new Error('删除至少需要一个 sessionId');
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
				title: args.action === 'delete' ? '删除归档会话' : '列出归档会话',
				kind: args.action === 'delete' ? 'write' : 'read',
			}),
		});
	});

	ctx.inject(['commands'], (commandCtx) => {
		commandCtx.commands.register({
			name: 'delete-archived',
			description: '列出归档会话，或删除它们（/delete-archived delete <会话ID...> --yes [--permanent]）',
			input: { hint: '[list | delete <会话ID...> --yes [--permanent]]' },
			handler: async (invocation) => {
				const parsed = parseCommand(invocation.line ?? '');
				switch (parsed.action) {
					case 'list': {
						const ids = archivedIds(ctx);
						return renderList(await describeArchived(sessionsRoot, ids), sessionsRoot);
					}
					case 'invalid':
						return { kind: 'error', text: `${parsed.reason}\n用法：/delete-archived [list | delete <会话ID...> --yes [--permanent]]` };
					case 'unconfirmed':
						return {
							kind: 'error',
							text: [
								`有 ${parsed.sessionIds.length} 个会话待删除，但没有确认，已中止。`,
								parsed.permanent
									? '永久模式下日志文件将被真正抹除，无法恢复。'
									: '日志文件会被移入回收站（可恢复）。',
								'',
								`确认请重跑：/delete-archived delete ${parsed.sessionIds.join(' ')} --yes${parsed.permanent ? ' --permanent' : ''}`,
							].join('\n'),
						};
					case 'delete': {
						const report = await deleteArchived(ctx, config, parsed.sessionIds, parsed.permanent);
						return renderDelete(report);
					}
					default:
						return { kind: 'error', text: '不支持的请求' };
				}
			},
		});
	});
}

export default { name, inject, apply };
