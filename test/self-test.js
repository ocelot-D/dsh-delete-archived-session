/**
 * Self-test for the delete-archived-session plugin.
 *
 * Builds a throwaway sessions root that mirrors the real JSONL layout, then
 * exercises the safety-critical paths: exact-name location, ownership proof,
 * root containment, reversible trash, permanent purge, and the "/delete-archived"
 * grammar. Run with: node test/self-test.js
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import {
	encodeSegment,
	projectKey,
	assertInside,
	findSessionDirIncludingNoCwd,
	inspectSession,
	purgeSessionDir,
	trashSessionDir,
} from '../lib/session-store.js';

const root = join(tmpdir(), `dsh-del-archived-test-${process.pid}`);
const cwd = 'C:\\Users\\example\\project';
const cwdAlt = 'C:\\Users\\example\\other';

/** Write one session directory in the shipped layout. */
async function writeSession(id, { cwd: sessionCwd = cwd, title } = {}) {
	const dir = join(root, projectKey(sessionCwd), encodeSegment(id));
	await mkdir(dir, { recursive: true });
	const header = { type: 'session', version: 4, id, createdAt: 1700000000000, cwd: sessionCwd, isSeeded: false, delegationDepth: 0 };
	if (title !== undefined) header.title = title;
	await writeFile(join(dir, `00000000-0000-0000-0000-000000000000-0001.jsonl`), `${JSON.stringify(header)}\n`);
	return dir;
}

await rm(root, { recursive: true, force: true });
let failures = 0;
const check = async (label, fn) => {
	try {
		await fn();
		console.log(`  ok   ${label}`);
	} catch (error) {
		failures += 1;
		console.log(`  FAIL ${label}\n       ${error.message}`);
	}
};

console.log('encoders');
await check('encodeSegment matches the shipped escape scheme', () => {
	assert.equal(encodeSegment('abc-123_x.y'), 'abc-123_x.y');
	assert.equal(encodeSegment('a/b'), 'a~002Fb');
	assert.equal(encodeSegment('..'), '~002E~002E');
});
await check('projectKey matches the shipped readable key', () => {
	assert.equal(projectKey('C:\\Users\\example\\project'), '--C-Users-example-project--');
});

console.log('location and verification');
const targetId = '11111111-2222-3333-4444-555555555555';
const targetDir = await writeSession(targetId, { title: 'Alpha' });
const otherId = '99999999-8888-7777-6666-555555555555';
await writeSession(otherId, { cwd: cwdAlt });
await writeSession('no-cwd-id', { cwd: undefined });

await check('finds a session by exact encoded name', async () => {
	assert.equal(await findSessionDirIncludingNoCwd(root, targetId), targetDir);
});
await check('inspect proves ownership and reports bytes', async () => {
	const info = await inspectSession(root, targetId);
	assert.equal(info.dir, targetDir);
	assert.equal(info.header.id, targetId);
	assert.ok(info.bytes > 0);
});
await check('unknown session resolves to undefined', async () => {
	assert.equal(await inspectSession(root, 'does-not-exist'), undefined);
});
await check('refuses a directory whose log belongs to another session', async () => {
	// Plant a directory named for `victim` but holding `otherId`'s log.
	const victim = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	const dir = join(root, projectKey(cwd), encodeSegment(victim));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'log.jsonl'), `${JSON.stringify({ type: 'session', version: 4, id: otherId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 })}\n`);
	await assert.rejects(() => inspectSession(root, victim), /no artifact proves/);
});
await check('refuses a directory with no log artifact', async () => {
	const empty = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
	const dir = join(root, projectKey(cwd), encodeSegment(empty));
	await mkdir(dir, { recursive: true });
	await assert.rejects(() => inspectSession(root, empty), /holds no session log artifact/);
});

console.log('containment');
await check('assertInside accepts a descendant', () => {
	assert.equal(assertInside(root, targetDir), targetDir);
});
await check('assertInside rejects the root itself', () => {
	assert.throws(() => assertInside(root, root), /sessions root itself/);
});
await check('assertInside rejects an escape', () => {
	assert.throws(() => assertInside(root, join(root, '..', 'elsewhere')), /outside the sessions root/);
});

console.log('compressed logs (zstd)');
const { zstdCompressSync } = await import('node:zlib');
/** Write one session directory holding a zstd-compressed log, like the live store. */
async function writeZstdSession(id, { corruptTail = false } = {}) {
	const dir = join(root, projectKey(cwd), encodeSegment(id));
	await mkdir(dir, { recursive: true });
	const header = { type: 'session', version: 4, id, createdAt: 1700000000000, cwd, isSeeded: false, delegationDepth: 0 };
	const body = `${JSON.stringify(header)}\n${JSON.stringify({ type: 'request/header', seq: 0 })}\n`;
	let frame = zstdCompressSync(Buffer.from(body, 'utf8'));
	if (corruptTail) frame = Buffer.concat([frame, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33])]);
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), frame);
	return dir;
}
await check('verifies a zstd-compressed log and reads its header', async () => {
	const id = 'zstd0001-0000-0000-0000-000000000001';
	await writeZstdSession(id);
	const info = await inspectSession(root, id);
	assert.equal(info.header.id, id);
	assert.ok(info.bytes > 0);
});
await check('a torn trailing frame still verifies (falls back to full decode)', async () => {
	const id = 'zstd0002-0000-0000-0000-000000000002';
	await writeZstdSession(id, { corruptTail: true });
	const info = await inspectSession(root, id);
	assert.equal(info.header.id, id);
});
await check('an unreadable compressed log refuses instead of throwing unhandled', async () => {
	const id = 'zstd0003-0000-0000-0000-000000000003';
	const dir = join(root, projectKey(cwd), encodeSegment(id));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not a zstd frame at all', 'utf8'));
	await assert.rejects(() => inspectSession(root, id), /cannot read compressed session log/);
});
await check('a compressed log naming another session is refused', async () => {
	const id = 'zstd0004-0000-0000-0000-000000000004';
	const dir = join(root, projectKey(cwd), encodeSegment(id));
	await mkdir(dir, { recursive: true });
	const other = { type: 'session', version: 4, id: targetId, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 };
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${JSON.stringify(other)}\n`, 'utf8')));
	await assert.rejects(() => inspectSession(root, id), /no artifact proves/);
});

console.log('deletion');
await check('trash is reversible and removes the original', async () => {
	const trash = join(root, '..', `dsh-del-archived-trash-${process.pid}`);
	await rm(trash, { recursive: true, force: true });
	const moved = await trashSessionDir(targetDir, trash);
	const [artifact] = await readdir(moved);
	const restored = JSON.parse((await readFile(join(moved, artifact), 'utf8')).split('\n')[0]);
	assert.equal(restored.id, targetId);
	assert.equal(await inspectSession(root, targetId), undefined);
	await rm(trash, { recursive: true, force: true });
});
await check('purge removes the directory permanently', async () => {
	const dir = await writeSession('cccccccc-dddd-eeee-ffff-000000000001');
	assert.ok(await inspectSession(root, 'cccccccc-dddd-eeee-ffff-000000000001'));
	await purgeSessionDir(dir);
	assert.equal(await inspectSession(root, 'cccccccc-dddd-eeee-ffff-000000000001'), undefined);
});

/**
 * Build a fake Cordis context that records registrations.
 *
 * The plugin mounts each surface through `ctx.inject([service], cb)`, so the
 * fake runs the callback immediately when that service is present and skips it
 * otherwise — which is exactly how the real behaviour is exercised here.
 * Registrations bubble up to the root collector, so a caller inspects
 * `harness.tools` / `harness.commands` rather than the child context.
 * @param services - the registries this context provides.
 * @param sink - shared collector, created at the root.
 * @returns the fake context plus the recorded tools and commands.
 */
function fakeContext(services = {}, sink = { tools: [], commands: [] }) {
	const ctx = {
		get: () => undefined,
		inject: (names, callback) => {
			if (names.every((serviceName) => services[serviceName] !== undefined)) {
				callback(fakeContext(services, sink));
			}
		},
	};
	if (services.tools !== undefined) ctx.tools = { register: (tool) => sink.tools.push(tool) };
	if (services.commands !== undefined) ctx.commands = { register: (command) => sink.commands.push(command) };
	Object.defineProperty(ctx, 'harness', { value: sink, enumerable: false });
	return ctx;
}

console.log('\ncommand grammar');
const { default: plugin } = await import('../lib/index.js');
await check('plugin exports the Cordis contract', () => {
	assert.equal(plugin.name, 'tool-delete-archived-session');
	assert.deepEqual(plugin.inject, [], 'no required injection, so the plugin always mounts');
	assert.equal(typeof plugin.apply, 'function');
});
await check('registers one tool and one command', () => {
	const ctx = fakeContext({ tools: true, commands: true });
	plugin.apply(ctx, { sessionsRoot: root });
	assert.equal(ctx.harness.tools.length, 1);
	assert.equal(ctx.harness.tools[0].name, 'delete_archived_sessions');
	assert.equal(ctx.harness.commands.length, 1);
	assert.equal(ctx.harness.commands[0].name, 'delete-archived');
});
await check('mounts the tool alone when there is no command registry', () => {
	const ctx = fakeContext({ tools: true });
	plugin.apply(ctx, { sessionsRoot: root });
	assert.equal(ctx.harness.tools.length, 1);
	assert.equal(ctx.harness.commands.length, 0);
});
await check('mounts the command alone when there is no tool registry', () => {
	const ctx = fakeContext({ commands: true });
	plugin.apply(ctx, { sessionsRoot: root });
	assert.equal(ctx.harness.commands.length, 1);
	assert.equal(ctx.harness.tools.length, 0);
});
await check('command refuses an unconfirmed delete', async () => {
	const ctx = fakeContext({ commands: true });
	plugin.apply(ctx, { sessionsRoot: root });
	const result = await ctx.harness.commands[0].handler({ line: `delete ${otherId}` });
	assert.equal(result.kind, 'error');
	assert.match(result.text, /without confirmation/);
});
await check('command reports an empty archive set', async () => {
	const ctx = fakeContext({ commands: true });
	ctx.get = (key) => (key === 'workspaceRegistry' ? { archivedSessionIds: [], unarchiveSession: async () => {} } : undefined);
	plugin.apply(ctx, { sessionsRoot: root });
	const result = await ctx.harness.commands[0].handler({ line: 'list' });
	assert.equal(result.kind, 'success');
	assert.match(result.text, /No archived sessions/);
});
await check('end-to-end: deletes an archived session and clears the archive entry', async () => {
	const id = 'dddddddd-eeee-ffff-0000-111111111111';
	await writeSession(id);
	const cleared = [];
	const ctx = fakeContext({ commands: true });
	ctx.get = (key) =>
		key === 'workspaceRegistry'
			? { archivedSessionIds: [id], unarchiveSession: async (sessionId) => cleared.push(sessionId) }
			: undefined;
	plugin.apply(ctx, { sessionsRoot: root, trashDir: join(root, '..', `dsh-del-archived-e2e-${process.pid}`) });
	const result = await ctx.harness.commands[0].handler({ line: `delete ${id} --yes` });
	assert.equal(result.kind, 'success', result.text);
	assert.match(result.text, /moved to/);
	assert.deepEqual(cleared, [id]);
	assert.equal(await inspectSession(root, id), undefined);
	await rm(join(root, '..', `dsh-del-archived-e2e-${process.pid}`), { recursive: true, force: true });
});
await check('end-to-end: refuses a non-archived session', async () => {
	const id = 'eeeeeeee-ffff-0000-1111-222222222222';
	await writeSession(id);
	const ctx = fakeContext({ commands: true });
	ctx.get = () => ({ archivedSessionIds: [], unarchiveSession: async () => {} });
	plugin.apply(ctx, { sessionsRoot: root });
	const result = await ctx.harness.commands[0].handler({ line: `delete ${id} --yes --permanent` });
	assert.match(result.text, /not an archived session/);
	assert.ok(await inspectSession(root, id), 'a non-archived session must survive');
});
await check('tool refuses a delete without confirm', async () => {
	const ctx = fakeContext({ tools: true });
	ctx.get = () => ({ archivedSessionIds: [], unarchiveSession: async () => {} });
	plugin.apply(ctx, { sessionsRoot: root });
	await assert.rejects(() => ctx.harness.tools[0].execute({ action: 'delete', sessionIds: ['x'] }), /confirm:true/);
});
await check('tool lists archived sessions with size and title', async () => {
	const id = 'ffffffff-0000-1111-2222-333333333333';
	await writeSession(id, { title: 'Beta' });
	const ctx = fakeContext({ tools: true });
	ctx.get = () => ({ archivedSessionIds: [id], unarchiveSession: async () => {} });
	plugin.apply(ctx, { sessionsRoot: root });
	const value = await ctx.harness.tools[0].execute({ action: 'list' });
	assert.equal(value.archived.length, 1);
	assert.equal(value.archived[0].sessionId, id);
	assert.equal(value.archived[0].title, 'Beta');
	assert.ok(value.archived[0].bytes > 0);
});

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
