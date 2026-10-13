/**
 * Validate the bundle manifest and patch structure without a YAML dependency,
 * including every machine-checkable requirement the plugin catalog imposes on a
 * submission. Run with: node test/check-manifest.js
 *
 * The catalog reads the repo's `package.json` over the GitHub API and rejects a
 * submission that declares only `dsh.client` (not installable), that declares no
 * `dsh.bundle.patch`, or that ships a patch file that is not actually present.
 * These checks mirror that gate locally so a submission is never bounced for
 * something a local run could have caught.
 */
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const yml = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8');
const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));

const rows = [...yml.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gmu)].map((m) => m[1]);
const names = [...yml.matchAll(/^\s*name:\s*'?([^'\r\n]+?)'?\s*$/gmu)].map((m) => m[1].trim());

assert.ok(/^-\s*insert:/mu.test(yml), 'patch must open with a top-level `- insert:` key');
assert.equal(rows.length, 1, 'patch must insert exactly one row');
assert.deepEqual(names, [pkg.name], 'the inserted row must name this package');

// Catalog requirement: dsh.bundle.patch, as one string or a list.
const declared = pkg.dsh?.bundle?.patch;
const patchList = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
assert.ok(patchList.length > 0, 'package.json must declare dsh.bundle.patch (dsh.client alone is NOT installable)');
for (const relative of patchList) {
	assert.ok(relative.startsWith('./'), `declared patch must be a relative path: ${relative}`);
	await access(join(pkgDir, relative));
}
assert.equal(patchList[0], './cordis.patch.yml');

assert.equal(pkg.type, 'module', 'the plugin is ESM');
assert.equal(pkg.main, 'lib/index.js');
assert.ok(pkg.files.includes('cordis.patch.yml'), 'cordis.patch.yml must ship in files[]');
assert.ok(pkg.files.includes('lib'), 'lib must ship in files[]');
assert.ok(pkg.license, 'a license is required');
assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('dsh-plugin'), 'the dsh-plugin keyword helps discovery');
assert.ok(pkg.description.endsWith('.'), 'the description is used verbatim as a catalog line; end it with a period');
assert.ok(!/\b(?:best|ultimate|amazing|revolutionary|powerful)\b/iu.test(pkg.description), 'catalog descriptions must avoid marketing superlatives');

// An explicit host requirement is what the market reads as engines.dsh.
const enginesDsh = pkg.engines?.dsh ?? pkg.dsh?.engines?.dsh;
assert.ok(typeof enginesDsh === 'string' && enginesDsh.length > 0, 'declare engines.dsh so the market can check host compatibility');
assert.ok(/-\d/u.test(enginesDsh), `engines.dsh must carry an explicit prerelease branch or it silently excludes every prerelease harness: ${enginesDsh}`);

// Zero runtime dependencies is a deliberate property of this plugin.
assert.equal(pkg.dependencies, undefined, 'this plugin ships with no runtime dependencies');
assert.equal(pkg.peerDependencies, undefined, 'this plugin declares no peers; it imports nothing outside node:');

console.log('manifest OK');
console.log(`  package  : ${pkg.name}@${pkg.version}`);
console.log(`  row id   : ${rows[0]}`);
console.log(`  row name : ${names[0]}`);
console.log(`  patch    : ${patchList[0]}`);
console.log(`  engines  : dsh ${enginesDsh}, node ${pkg.engines?.node}`);
