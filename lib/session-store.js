/**
 * Filesystem helpers for locating, verifying, and removing archived session
 * logs stored by `@deepseek-ai/dsh-session-persistence-jsonl`.
 *
 * DSH has no "delete session" API: archiving only hides a session, and its log
 * stays on disk forever. Everything in this module exists to make the physical
 * deletion safe, so the rules are deliberately conservative:
 *
 *  - The storage layout is recomputed here rather than read from the runtime, so
 *    the plugin does not depend on private persistence internals. The two pure
 *    encoders below are byte-for-byte copies of the shipped ones; see
 *    `@deepseek-ai/dsh-session-persistence-jsonl` (`encodeSegment`, `projectKey`).
 *  - A session directory is located by scanning for its EXACT encoded name, so a
 *    malformed id can never escape the sessions root.
 *  - Before anything is deleted, the first log record is read and its `id` must
 *    equal the requested session id. A directory whose contents do not prove
 *    ownership is refused, never deleted.
 *
 * @module dsh-plugin-delete-archived-session/session-store
 */

import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

/** File suffix of a plaintext session log. */
const PLAINTEXT_SUFFIX = '.jsonl';
/** File suffix of a Zstandard-compressed session log. */
const COMPRESSED_SUFFIX = '.jsonl.zstd';
/** Ceiling for decoding a whole compressed log in memory as a fallback (64 MiB). */
const MAX_FULL_DECODE_BYTES = 64 * 1024 * 1024;

/**
 * Encode an arbitrary string as one safe path segment, injectively over all
 * JS (UTF-16) strings. Verbatim copy of the persistence backend's encoder so a
 * computed directory name matches the one the backend wrote.
 * @param raw - the string to encode; must be non-empty.
 * @returns the escaped single path segment, decodable back to `raw`.
 */
export function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment');
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}

/**
 * Build the readable directory key for a project path. Verbatim copy of the
 * persistence backend's encoder (lossy by design: separators collapse).
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
export function projectKey(cwd) {
	if (cwd.length === 0) throw new Error('cannot encode an empty project path');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Resolve the harness home using the same precedence as `@deepseek-ai/dsh-home-paths`:
 * an explicit override, then `$DSH_HOME` (blank treated as unset), then `~/.dsh`.
 * @param configured - explicit harness-home override, when the plugin config supplies one.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured, env = process.env) {
	const fromEnv = env.DSH_HOME;
	const chosen = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'));
	return resolve(expandHome(chosen));
}

/**
 * Expand a leading `~` against the current user's home directory.
 * @param path - path that may start with `~` or `~/`.
 * @returns the expanded path.
 */
function expandHome(path) {
	if (path === '~') return homedir();
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Resolve the directory that holds stored session logs.
 * @param configuredRoot - explicit sessions root from plugin config, when present.
 * @param dshHome - explicit harness home override, when present.
 * @returns the absolute sessions root path.
 */
export function resolveSessionsRoot(configuredRoot, dshHome) {
	if (configuredRoot !== undefined && configuredRoot.trim().length > 0) return resolve(expandHome(configuredRoot));
	return join(resolveDshHome(dshHome), 'sessions');
}

/**
 * Assert that a candidate path is a strict descendant of a base directory.
 * Deletion never runs on a path that escapes the sessions root.
 * @param base - the sessions root.
 * @param candidate - the path about to be touched.
 * @returns the resolved candidate path.
 * @throws {Error} when the candidate is not inside `base`.
 */
export function assertInside(base, candidate) {
	const resolvedBase = resolve(base);
	const resolvedCandidate = resolve(candidate);
	if (resolvedCandidate === resolvedBase) throw new Error(`refusing to operate on the sessions root itself: ${resolvedCandidate}`);
	if (!resolvedCandidate.startsWith(resolvedBase + sep)) {
		throw new Error(`refusing to operate outside the sessions root: ${resolvedCandidate} is not under ${resolvedBase}`);
	}
	return resolvedCandidate;
}

/**
 * Whether a path exists.
 * @param path - candidate path.
 * @returns true when the path exists.
 */
async function pathExists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * Locate one stored session's directory below the sessions root.
 *
 * The session directory is named by the encoding of its id, so the search is a
 * scan for an exact name match. Nothing is inferred from a partial match, and a
 * hit outside `root` is impossible because the name is a single encoded segment.
 *
 * @param root - the absolute sessions root.
 * @param sessionId - the session to locate.
 * @returns the session directory path, or `undefined` when no directory matches.
 */
export async function findSessionDir(root, sessionId) {
	const wanted = encodeSegment(sessionId);
	let projectEntries;
	try {
		projectEntries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	}
	const matches = [];
	for (const projectEntry of projectEntries) {
		if (!projectEntry.isDirectory()) continue;
		const candidate = join(root, projectEntry.name, wanted);
		if (await pathExists(candidate)) matches.push(candidate);
	}
	if (matches.length === 0) return undefined;
	if (matches.length > 1) {
		throw new Error(`session "${sessionId}" is ambiguous: ${matches.length} directories match across project folders`);
	}
	return matches[0];
}

/**
 * Locate one stored session's directory below the sessions root, additionally
 * checking the `_no-cwd` folder used for sessions whose header carries no cwd.
 * @param root - the absolute sessions root.
 * @param sessionId - the session to locate.
 * @returns the session directory path, or `undefined` when no directory matches.
 */
export async function findSessionDirIncludingNoCwd(root, sessionId) {
	const direct = await findSessionDir(root, sessionId);
	if (direct !== undefined) return direct;
	const noCwd = join(root, '_no-cwd', encodeSegment(sessionId));
	return (await pathExists(noCwd)) ? noCwd : undefined;
}

/**
 * List the log artifacts inside one session directory.
 * @param dir - a session directory.
 * @returns absolute paths of plaintext and compressed log artifacts, sorted.
 */
export async function listLogArtifacts(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && (entry.name.endsWith(PLAINTEXT_SUFFIX) || entry.name.endsWith(COMPRESSED_SUFFIX)))
		.map((entry) => join(dir, entry.name))
		.sort();
}

/**
 * Parse the first non-empty line of a text stream, always tearing the stream
 * down afterwards.
 *
 * Both the source and any decompressor in the chain must be destroyed, and both
 * must have error listeners attached by the caller: an unhandled `error` event
 * on a zlib stream is an uncaught exception, which inside the Harness host
 * process would be fatal. Verification failures must stay recoverable.
 *
 * @param source - readable stream of UTF-8 log text.
 * @returns the parsed first record, or `undefined` when the log is empty.
 */
async function firstRecordOf(source) {
	const lines = createInterface({ input: source, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const text = line.trim();
			if (text.length === 0) continue;
			return JSON.parse(text);
		}
		return undefined;
	} finally {
		lines.close();
		source.destroy();
	}
}

/**
 * Read the first record of a plaintext log without scanning the whole file.
 * @param path - a `.jsonl` artifact.
 * @returns the parsed first record, or `undefined` when the artifact is empty.
 */
export async function readFirstRecord(path) {
	const stream = createReadStream(path);
	stream.on('error', () => {});
	try {
		return await firstRecordOf(stream);
	} finally {
		stream.destroy();
	}
}

/**
 * Read the first record of a Zstandard-compressed log by streaming it through a
 * decompressor, so verifying a large log never materializes the whole file.
 *
 * A log still being appended by a live session can present a torn frame, so the
 * decompressor is treated as fallible: its error settles this promise instead of
 * escaping, and every stream in the chain is destroyed.
 *
 * @param path - a `.jsonl.zstd` artifact.
 * @returns the parsed first record, or `undefined` when the artifact is empty.
 */
export async function readFirstRecordFromZstd(path) {
	const source = createReadStream(path);
	const decompressor = createZstdDecompress();
	// Attach handlers before piping: without these, a decode error on either
	// stream is an unhandled 'error' event rather than a rejected promise.
	source.on('error', () => {});
	decompressor.on('error', () => {});
	try {
		return await firstRecordOf(source.pipe(decompressor));
	} finally {
		decompressor.destroy();
		source.destroy();
	}
}

/**
 * Read the first record by decoding the whole artifact in memory.
 *
 * This is the fallback for the rare log the streaming path cannot decode. It is
 * bounded by {@link MAX_FULL_DECODE_BYTES} so a pathological log cannot exhaust
 * memory; beyond that bound the streaming failure is reported instead.
 *
 * @param path - a `.jsonl.zstd` artifact.
 * @param size - the artifact's size in bytes.
 * @returns the parsed first record, or `undefined` when the artifact is empty.
 */
async function readFirstRecordByFullDecode(path, size) {
	if (size > MAX_FULL_DECODE_BYTES) {
		throw new Error(`log is too large to decode in memory (${size} bytes > ${MAX_FULL_DECODE_BYTES})`);
	}
	const text = zstdDecompressSync(await readFile(path)).toString('utf8');
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		return JSON.parse(trimmed);
	}
	return undefined;
}

/**
 * Read a possibly compressed log artifact's first record.
 *
 * The streaming path is preferred; when it fails (a torn frame in a log being
 * appended, or an exotic encoding) the full decode is tried before giving up, so
 * a transient read failure does not by itself block a legitimate deletion. A
 * record that cannot be read at all still means "ownership unproven", and the
 * caller refuses the delete.
 *
 * @param path - a `.jsonl` or `.jsonl.zstd` artifact.
 * @returns the parsed first record, or `undefined` when the artifact is empty.
 */
async function readHeaderRecord(path) {
	if (!path.endsWith(COMPRESSED_SUFFIX)) return readFirstRecord(path);
	const { size } = await stat(path);
	let streamError;
	try {
		return await readFirstRecordFromZstd(path);
	} catch (error) {
		streamError = error;
	}
	try {
		return await readFirstRecordByFullDecode(path, size);
	} catch (error) {
		throw new Error(`cannot read compressed session log ${path}: streaming failed (${streamError.message}); full decode failed (${error.message})`);
	}
}

/**
 * Verify that a directory genuinely holds the requested session's log.
 *
 * This is the single guard standing between a request and data loss, so it
 * demands positive proof: at least one readable artifact whose first record
 * carries the exact requested id. A directory with no artifacts, or with a
 * record naming a different session, is refused.
 *
 * @param dir - the candidate session directory.
 * @param sessionId - the id the caller asked to delete.
 * @returns the verified artifact paths.
 * @throws {Error} when ownership cannot be proven.
 */
export async function verifySessionDir(dir, sessionId) {
	const artifacts = await listLogArtifacts(dir);
	if (artifacts.length === 0) {
		throw new Error(`refusing to delete ${dir}: it holds no session log artifact, so session "${sessionId}" ownership is unproven`);
	}
	const failures = [];
	for (const artifact of artifacts) {
		try {
			const record = await readHeaderRecord(artifact);
			if (record === undefined) {
				failures.push(`${artifact}: empty log`);
				continue;
			}
			if (record.id !== sessionId) {
				failures.push(`${artifact}: log belongs to "${String(record.id)}"`);
				continue;
			}
			return { dir, artifacts, header: record };
		} catch (error) {
			failures.push(`${artifact}: ${error.message}`);
		}
	}
	throw new Error(`refusing to delete ${dir}: no artifact proves it belongs to session "${sessionId}" (${failures.join('; ')})`);
}

/**
 * Read one session's stored header without deleting anything.
 * @param root - the absolute sessions root.
 * @param sessionId - the session to inspect.
 * @returns the session directory, artifacts, header, and total bytes, or `undefined` when absent.
 */
export async function inspectSession(root, sessionId) {
	const dir = await findSessionDirIncludingNoCwd(root, sessionId);
	if (dir === undefined) return undefined;
	const verified = await verifySessionDir(dir, sessionId);
	let bytes = 0;
	for (const artifact of verified.artifacts) bytes += (await stat(artifact)).size;
	return { sessionId, dir, artifacts: verified.artifacts, header: verified.header, bytes };
}

/**
 * Move one session directory into the trash, returning the new location.
 *
 * The trashed copy keeps the EXACT `projectDir/sessionDir` path it had under the
 * sessions root, only nested under a timestamped batch folder:
 *
 *   <root>/<projectKey>/<encodedId>  ->  <trashDir>/<timestamp>/<projectKey>/<encodedId>
 *
 * Preserving the session folder's name is what makes the deletion reversible:
 * DSH locates a session by that exact encoded name, so restoring is a plain move
 * back. Renaming the folder (for example prefixing it with a timestamp) would
 * produce a directory the backend can no longer find — the log would survive but
 * the session would be unrecoverable.
 *
 * A same-volume rename is atomic; across volumes the rename fails with `EXDEV`
 * and the caller is told rather than silently doing a copy that could
 * half-finish.
 *
 * @param dir - the verified session directory.
 * @param trashDir - destination trash root.
 * @returns the path the session was moved to.
 */
export async function trashSessionDir(dir, trashDir) {
	const sessionName = basename(dir);
	const projectName = basename(dirname(dir));
	if (sessionName.length === 0 || projectName.length === 0) {
		throw new Error(`cannot derive a restorable trash path for ${dir}`);
	}
	const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
	const destination = join(trashDir, stamp, projectName, sessionName);
	await mkdir(dirname(destination), { recursive: true });
	try {
		await rename(dir, destination);
	} catch (error) {
		if (error.code === 'EXDEV') {
			throw new Error(`cannot move ${dir} to ${destination}: the trash directory is on another volume; choose a trashDir on the same drive or pass permanent:true`);
		}
		if (error.code === 'EEXIST') {
			throw new Error(`cannot move ${dir} to ${destination}: destination already exists`);
		}
		throw error;
	}
	return destination;
}

/**
 * Permanently remove one verified session directory.
 * @param dir - the verified session directory.
 * @returns the number of files removed.
 */
export async function purgeSessionDir(dir) {
	const artifacts = await listLogArtifacts(dir);
	await rm(dir, { recursive: true, force: false });
	return artifacts.length;
}

/**
 * Report the on-disk size of a session directory.
 * @param dir - a session directory.
 * @returns total artifact bytes.
 */
export async function sessionDirBytes(dir) {
	let bytes = 0;
	for (const artifact of await listLogArtifacts(dir)) bytes += (await stat(artifact)).size;
	return bytes;
}

export { COMPRESSED_SUFFIX, PLAINTEXT_SUFFIX };
