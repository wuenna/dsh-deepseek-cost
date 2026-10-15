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

const PROFILE_ROOT = 'C:/Users/wuw/.dsh/profiles';
/** Profiles that may load the plugin, most likely first. */
const PROFILE_NAMES = ['desktop', 'web'];

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
	// 2 added the per-turn ledger, 3 added the `deepseek-account` route to the
	// billed set; a mismatched checkpoint is replayed from the log rather than
	// trusted, which is what retro-prices calls logged under the older rules.
	assert.equal(host.deepseekCostProjectionDefinition.stateVersion, 3);
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

// 5. The Cordis loader resolves this package by name from every profile that
//    loads it — the desktop app runs the `desktop` profile, `dsh web` the `web`
//    one — which is how the `deepseek-cost` row finds it.
{
	let checked = 0;
	for (const profile of PROFILE_NAMES) {
		const manifestPath = join(PROFILE_ROOT, profile, 'package.json');
		if (!existsSync(manifestPath)) {
			console.log(`5 ..  no ${profile} profile at ${join(PROFILE_ROOT, profile)}`);
			continue;
		}
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
		const declared = manifest.dependencies?.['dsh-deepseek-cost'] !== undefined || (manifest.dsh?.profile?.bundles ?? []).includes('dsh-deepseek-cost');
		if (!declared) {
			console.log(`5 ..  the ${profile} profile does not load this plugin`);
			continue;
		}
		const requireFromProfile = createRequire(manifestPath);
		const root = requireFromProfile.resolve('dsh-deepseek-cost');
		const client = requireFromProfile.resolve('dsh-deepseek-cost/client');
		assert.match(root.replace(/\\/g, '/'), /lib\/index\.js$/, `${profile} must resolve to the host half`);
		assert.match(client.replace(/\\/g, '/'), /lib\/client\.js$/, `${profile} must resolve to the browser half`);
		checked += 1;
		console.log(`5 ok  resolves from the ${profile} profile`.padEnd(36), root);
	}
	assert.ok(checked > 0, 'the plugin must resolve from at least one installed profile');
}

// 6. The settings plugin list reads a plugin's display name and summary from
//    `<package>/locale/<language>.json` through the package's own exports
//    (`readPluginMeta` in @deepseek-ai/dsh-app-boot enumerates that directory,
//    and `ctx.locale.resolveText` picks the active language). Both the English
//    fallback the reader requires and the Chinese text the UI shows must
//    therefore resolve from every profile that loads the plugin: without the
//    `./locale/*.json` export the files are invisible and the list silently
//    falls back to the bare package name.
{
	let checked = 0;
	for (const profile of PROFILE_NAMES) {
		const manifestPath = join(PROFILE_ROOT, profile, 'package.json');
		if (!existsSync(manifestPath)) continue;
		const requireFromProfile = createRequire(manifestPath);
		let english;
		try {
			english = requireFromProfile.resolve('dsh-deepseek-cost/locale/en.json');
		} catch {
			continue; // this profile does not load the plugin
		}
		const chinese = requireFromProfile.resolve('dsh-deepseek-cost/locale/zh.json');
		for (const [language, file] of [['en', english], ['zh', chinese]]) {
			const parsed = JSON.parse(readFileSync(file, 'utf8'));
			assert.equal(typeof parsed.meta?.title, 'string', `${language}.json needs meta.title`);
			assert.equal(typeof parsed.meta?.description, 'string', `${language}.json needs meta.description`);
			assert.notEqual(parsed.meta.title.trim(), '', `${language} title must not be empty`);
			assert.notEqual(parsed.meta.description.trim(), '', `${language} description must not be empty`);
		}
		const zh = JSON.parse(readFileSync(chinese, 'utf8'));
		assert.match(zh.meta.title, /[\u4e00-\u9fff]/, 'the Chinese title must actually be Chinese');
		assert.match(zh.meta.description, /[\u4e00-\u9fff]/, 'the Chinese summary must actually be Chinese');
		assert.match(JSON.parse(readFileSync(english, 'utf8')).meta.title, /^[\x20-\x7e]+$/, 'the English title stays ASCII');
		checked += 1;
		console.log(`6 ok  display metadata resolves from the ${profile} profile`.padEnd(50), 'en + zh');
	}
	assert.ok(checked > 0, 'the display metadata must resolve from at least one installed profile');
}

// Restore the environment and drop the throwaway home.
if (previousHome === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = previousHome;
rmSync(sandboxHome, { recursive: true, force: true });

console.log('\nall checks passed');
