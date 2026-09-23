/**
 * Wiring checks for dsh-deepseek-cost: the host half registers its unit, and the
 * package resolves from the web profile exactly as the Cordis loader will ask
 * for it (`dsh-deepseek-cost`, plus the `./client` export the client-modules
 * node half reads).
 *
 * Run with `node test/wiring.test.mjs` from the package root. The resolution
 * half is skipped when this machine has no web profile yet.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as host from '../lib/index.js';

const PROFILE_DIR = 'C:/Users/wuw/.dsh/profiles/web';

// `apply()` writes its one-line activation record under `$DSH_HOME`; point that
// at a throwaway home so running this suite never touches the real state dir.
const sandboxHome = mkdtempSync(join(tmpdir(), 'dsh-cost-home-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = sandboxHome;

// 1. The host half declares the one service it needs and registers one key.
{
	assert.equal(host.name, 'deepseek-cost');
	assert.deepEqual(host.inject, ['sessionProjections']);
	assert.equal(host.deepseekCostProjectionDefinition.key, 'deepseekCost');
	// 2 added the per-turn ledger; a version-1 checkpoint fails the state schema
	// and is replayed from the log instead of being trusted.
	assert.equal(host.deepseekCostProjectionDefinition.stateVersion, 2);
	assert.deepEqual(host.deepseekCostProjectionDefinition.init().turns, {}, 'the ledger starts empty');
	assert.equal(typeof host.deepseekCostProjectionDefinition.init, 'function');
	assert.equal(typeof host.deepseekCostProjectionDefinition.apply, 'function');
	assert.equal(typeof host.deepseekCostProjectionDefinition.stateSchema.parse, 'function');
	assert.equal(typeof host.deepseekCostProjectionDefinition.wire.viewSchema.parse, 'function');
	assert.equal(typeof host.deepseekCostProjectionDefinition.wire.view, 'function');
	console.log('1 ok  host half declares its unit');
}

// 2. apply() registers exactly that definition and records its activation under
//    the state dir, which is what makes a silent non-mount diagnosable.
{
	const registered = [];
	const ctx = { sessionProjections: { register: (definition) => registered.push(definition) } };
	host.apply(ctx);
	assert.deepEqual(registered, [host.deepseekCostProjectionDefinition]);
	assert.equal(host.deepseekCostProjectionDefinition.init().client.currency, 'CNY');

	const record = join(sandboxHome, 'dsh-deepseek-cost', 'boot.log');
	assert.equal(existsSync(record), true, 'apply() writes the activation record');
	assert.match(readFileSync(record, 'utf8'), /host half mounted: projection "deepseekCost" registered/);
	console.log('2 ok  apply() registers and records  ', record.replace(sandboxHome, '$DSH_HOME'));
}

// 3. The projection survives a full state-schema round trip, as the persisted
//    checkpoint cache requires.
{
	const state = host.deepseekCostProjectionDefinition.init();
	const restored = host.deepseekCostProjectionDefinition.stateSchema.parse(JSON.parse(JSON.stringify(state)));
	assert.deepEqual(restored, state);
	console.log('3 ok  state round-trips as plain JSON');
}

// 4. Every value the unit publishes passes the wire schema, including the empty
//    initial one.
{
	const definition = host.deepseekCostProjectionDefinition;
	definition.wire.viewSchema.parse(definition.wire.view(definition.init()));
	assert.throws(() => definition.wire.viewSchema.parse({ ...definition.wire.view(definition.init()), cost: -1 }));
	assert.throws(() => definition.wire.viewSchema.parse({ ...definition.wire.view(definition.init()), currency: 'EUR' }));
	console.log('4 ok  wire schema rejects bad values');
}

// 5. The Cordis loader resolves this package by name from the profile directory,
//    which is how the `deepseek-cost` row finds it.
{
	if (!existsSync(join(PROFILE_DIR, 'package.json'))) {
		console.log('5 skip no web profile at ' + PROFILE_DIR);
	} else {
		const requireFromProfile = createRequire(join(PROFILE_DIR, 'package.json'));
		const root = requireFromProfile.resolve('dsh-deepseek-cost');
		const client = requireFromProfile.resolve('dsh-deepseek-cost/client');
		assert.match(root.replace(/\\/g, '/'), /lib\/index\.js$/);
		assert.match(client.replace(/\\/g, '/'), /lib\/client\.js$/);
		console.log('5 ok  resolves from the profile     ', root);
	}
}

// Restore the environment and drop the throwaway home.
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
rmSync(sandboxHome, { recursive: true, force: true });

console.log('\nall checks passed');
