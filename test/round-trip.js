/**
 * End-to-end round-trip against a COPY of a real session directory.
 *
 * Proves the two guarantees that matter on live data: a real zstd-compressed
 * session log verifies and moves to trash, and the move is genuinely
 * recoverable — the trashed folder still carries the exact project/session names
 * the backend locates sessions by, so moving it back restores the session.
 *
 * Usage: node test/round-trip.js <sandboxRoot> <sessionId>
 */
import assert from 'node:assert/strict';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inspectSession, trashSessionDir } from '../lib/session-store.js';

const [sandboxRoot, sessionId] = process.argv.slice(2);
assert.ok(sandboxRoot && sessionId, 'usage: node test/round-trip.js <sandboxRoot> <sessionId>');

const before = await inspectSession(sandboxRoot, sessionId);
assert.ok(before, `session ${sessionId} must be discoverable in the sandbox`);
assert.equal(before.header.id, sessionId, 'ownership must be proven by the log header');
console.log(`  ok   verified a real zstd log (${before.bytes} bytes, ${before.artifacts.length} artifact(s))`);

const projectName = basename(dirname(before.dir));
const sessionName = basename(before.dir);

const trash = `${sandboxRoot}-trash`;
const moved = await trashSessionDir(before.dir, trash);
console.log(`  ok   moved to trash: ${moved.replace(trash, '<trash>')}`);

assert.equal(await inspectSession(sandboxRoot, sessionId), undefined, 'the session must be gone from the live root');
console.log('  ok   session is gone from the live root');

// The trashed folder must keep the exact names the backend locates sessions by.
assert.equal(basename(moved), sessionName, 'the session folder must keep its exact encoded name');
assert.equal(basename(dirname(moved)), projectName, 'the project folder must keep its exact key');
console.log('  ok   trashed folder keeps its original project/session names');

// Restore is therefore a plain move back to the same relative path.
const restoredPath = join(sandboxRoot, projectName, sessionName);
await rename(moved, restoredPath);
const restored = await inspectSession(sandboxRoot, sessionId);
assert.ok(restored, 'the restored session must be discoverable at its original path');
assert.equal(restored.header.id, sessionId);
assert.equal(restored.bytes, before.bytes, 'a trash round-trip must preserve every byte');
console.log('  ok   restore-by-move-back works: session is intact and re-verified');

await rm(trash, { recursive: true, force: true });
console.log('  ok   trash cleaned up');
