/**
 * Validate this plugin's registry descriptors against the REAL DSH validator.
 *
 * `@deepseek-ai/dsh-tools` cannot be imported standalone (it needs the harness's
 * own peers), so the shipped `lib/index.js` is loaded with those imports stubbed
 * via a module loader hook. That exercises the actual `assertSupportedJsonSchema`
 * the runtime calls in `tools.register()`, which is the thing that decides
 * whether the plugin mounts or throws at startup.
 *
 * Usage: node test/validate-against-dsh.js <path-to-extracted-dsh-tools-index.js>
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
assert.ok(target, 'usage: node test/validate-against-dsh.js <dsh-tools/lib/index.js>');
const targetUrl = isAbsolute(target) ? pathToFileURL(target).href : target;

// Stub every @deepseek-ai/* peer the extracted module imports.
const STUBS = {
	'@deepseek-ai/cordis': 'export class Service { constructor() {} }',
	// schemastery is used at module-init time to build Config schemas; a
	// chainable callable proxy satisfies every `z.x(...)` shape without pulling
	// the real package in.
	'@deepseek-ai/schemastery': 'const z = new Proxy(function () {}, { get: (t, k) => (k === "default" ? z : z), apply: () => z }); export default z; export { z };',
	'@deepseek-ai/dsh-scope': 'export const AnonymousEntries = class {}; export const NamedEntries = class {}; export const ScopedLayers = class {}; export const scopeOf = () => undefined; export const scopeTarget = () => undefined;',
	'@deepseek-ai/dsh-llm': 'export class HarnessError extends Error {}; export const createUserMessage = () => ({});',
	'@deepseek-ai/dsh-util-values': 'export const assertNever = () => {}; export const deepFreeze = (v) => v; export const isJsonValue = () => true; export const snapshotJsonValue = (v) => v;',
	'@deepseek-ai/dsh-brand': 'export const brandString = (v) => v;',
	'@deepseek-ai/dsh-sandbox': 'export const ESCALATION_TARGETS = []; export const approveEscalation = async () => true; export const validateEscalationArgs = () => [];',
};

register(
	`data:text/javascript,${encodeURIComponent(`
const stubs = ${JSON.stringify(STUBS)};
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) {
    return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  }
  return next(specifier, context);
}
`)}`,
	import.meta.url,
);

const dshTools = await import(targetUrl);
assert.equal(typeof dshTools.assertSupportedJsonSchema, 'function', 'the real validator must be importable');

// Capture what the plugin registers.
const sink = { tools: [], commands: [] };
const ctx = {
	get: () => undefined,
	inject: (names, callback) => {
		callback({
			tools: { register: (tool) => sink.tools.push(tool) },
			commands: { register: (command) => sink.commands.push(command) },
		});
	},
};

const plugin = (await import('../lib/index.js')).default;
plugin.apply(ctx, {});

assert.equal(sink.tools.length, 1);
assert.equal(sink.commands.length, 1);
const tool = sink.tools[0];

// 1. The output schema must satisfy the validator tools.register() calls.
dshTools.assertSupportedJsonSchema(tool.output.schema);
console.log('  ok   output.schema passes the real assertSupportedJsonSchema');

// 2. The parameters schema must satisfy the same enforced subset.
dshTools.assertSupportedJsonSchema(tool.parameters);
console.log('  ok   parameters passes the real assertSupportedJsonSchema');

// 3. The output object must actually validate against its own schema.
const good = { action: 'list', sessionsRoot: 'C:/x', archived: [], results: [] };
assert.deepEqual(dshTools.validateJsonSchemaValue(tool.output.schema, good, ''), []);
console.log('  ok   a well-formed result validates against output.schema');

// 4. A malformed result must be rejected (proves the schema constrains anything).
const bad = { action: 42, archived: [], results: [] };
assert.ok(dshTools.validateJsonSchemaValue(tool.output.schema, bad, '').length > 0);
console.log('  ok   a malformed result is rejected by output.schema');

// 5. Arguments validate against the declared parameters.
assert.deepEqual(dshTools.validateJsonSchemaValue(tool.parameters, { action: 'list' }, ''), []);
assert.deepEqual(
	dshTools.validateJsonSchemaValue(tool.parameters, { action: 'delete', sessionIds: ['a'], confirm: true }, ''),
	[],
);
assert.ok(dshTools.validateJsonSchemaValue(tool.parameters, { action: 'nope' }, '').length > 0);
console.log('  ok   tool arguments validate, and a bad enum value is rejected');

// 6. The command descriptor carries the fields the registry requires.
const command = sink.commands[0];
assert.equal(typeof command.name, 'string');
assert.equal(typeof command.description, 'string');
assert.equal(typeof command.handler, 'function');
console.log('  ok   command descriptor has name/description/handler');

// 7. Regression guard: the schemastery author-spec form must be REJECTED here.
// `defineTool` compiles that form, but a raw descriptor is validated directly —
// so a stray `required: true` on a property fails at registration. This asserts
// the validator is strict enough that the previous form would have been caught.
const authorSpecForm = {
	type: 'object',
	additionalProperties: false,
	properties: {
		action: { type: 'string', required: true },
		archived: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
	},
};
assert.throws(
	() => dshTools.assertSupportedJsonSchema(authorSpecForm),
	/json schema|required/iu,
);
console.log('  ok   the old per-field `required: true` form is rejected (regression guard)');

console.log('\nVALIDATED AGAINST REAL DSH CODE');
