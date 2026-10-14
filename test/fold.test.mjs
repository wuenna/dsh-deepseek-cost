/**
 * Fold and pricing checks for dsh-deepseek-cost.
 *
 * Run with `node test/fold.test.mjs` from the package root. The first two cases
 * reproduce two aggregates from a real DeepSeek console ledger (2026-09-10 and
 * 2026-09-11) under the price tiers in force on those days, which is the
 * strongest available evidence that the tier table, the peak window, and the
 * bucket mapping all agree with the provider's own billing.
 */
import assert from 'node:assert/strict';

import { deepseekCostProjectionDefinition as unit } from '../lib/index.js';

/** Beijing wall clock as epoch milliseconds. */
const bj = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) - 8 * 3600 * 1000;

let seq = 0;
const event = (type, data, time) => ({ type, data, time, seq: seq++ });

const start = (turn, step, time) => [event('turn/start', { turn }, time), event('step/start', { turn, step }, time)];

const message = (turn, step, time, usage, route) =>
	event(
		'assistant/message',
		{
			turn,
			step,
			message: { source: route === undefined ? {} : { provider: route.provider, model: route.model } },
			stream: [],
			usage
		},
		time
	);

/** Fold one event list through the unit and return the client view. */
function fold(events) {
	let state = unit.init();
	for (const e of events) state = unit.apply(state, e);
	return unit.wire.view(state);
}

const usage = (input, output, cacheRead, cacheWrite = 0) => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: cacheRead,
	cacheWriteTokens: cacheWrite
});

// 1. Legacy flash tier, off-peak (2026-09-10 08:00 Beijing) — ledger 7.138138.
{
	const at = bj(2026, 9, 10, 8, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(508902, 226133, 107143424), { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	assert.equal(view.peak, false);
	assert.ok(Math.abs(view.cost - 7.1381227) < 1e-5, `expected ≈7.1381227, got ${view.cost}`);
	assert.equal(view.calls, 1);
	assert.equal(view.turnCost, view.cost);
	console.log('1 ok  legacy tier / off-peak        ', view.cost.toFixed(6));
}

// 2. Legacy flash tier, peak (2026-09-09 10:00 Beijing) — ledger 0.671941 for the
//    same token mix on 2026-09-11. The ledger priced that day with the superseded
//    table (the new rates took effect on 2026-09-10 12:00), which is exactly what
//    case 2b distinguishes; the arithmetic is the check here.
{
	const at = bj(2026, 9, 9, 10, 0);
	assert.notEqual(new Date(at + 8 * 3600 * 1000).getUTCDay() % 6, 0, 'fixture must be a weekday');
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(51721, 24687, 2945920), { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	assert.equal(view.peak, true);
	assert.ok(Math.abs(view.cost - 0.671938) < 1e-5, `expected ≈0.671938, got ${view.cost}`);
	console.log('2 ok  legacy tier / peak            ', view.cost.toFixed(6));
}

// 2b. Same instant-of-day one week later, when the new flash tier is in force.
{
	const at = bj(2026, 9, 11, 10, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(51721, 24687, 2945920), { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	assert.equal(view.peak, true);
	assert.ok(Math.abs(view.cost - 0.4187748) < 1e-6, `expected 0.4187748, got ${view.cost}`);
	console.log('2b ok new tier / same token mix     ', view.cost.toFixed(6));
}

// 3. Current flash tier, off-peak (2026-09-11 20:00 Beijing).
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 1e6, 1e6), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })]);
	assert.equal(view.peak, false);
	// 1M uncached * 1 + 1M output * 4 + 1M cache read * 0.02
	assert.ok(Math.abs(view.cost - 5.02) < 1e-9, `expected 5.02, got ${view.cost}`);
	assert.ok(Math.abs(view.turnOutputCost - 4) < 1e-9);
	assert.ok(Math.abs(view.turnUncachedCost - 1) < 1e-9);
	assert.ok(Math.abs(view.turnCacheReadCost - 0.02) < 1e-9);
	console.log('3 ok  current tier / off-peak       ', view.cost.toFixed(6));
}

// 4. Current flash tier, peak = exactly twice off-peak.
{
	const at = bj(2026, 9, 11, 10, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 1e6, 1e6), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })]);
	assert.ok(Math.abs(view.cost - 10.04) < 1e-9, `expected 10.04, got ${view.cost}`);
	console.log('4 ok  current tier / peak is 2x     ', view.cost.toFixed(6));
}

// 5. V4 Pro tier (peak 9 / 27 / 0.3 published → off-peak halves).
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 1e6, 1e6), { provider: 'deepseek-official', model: 'deepseek-v4-pro' })]);
	assert.ok(Math.abs(view.cost - 18.15) < 1e-9, `expected 18.15, got ${view.cost}`);
	console.log('5 ok  v4-pro tier / off-peak        ', view.cost.toFixed(6));
}

// 6. Weekends are off-peak — the published windows are Monday through Friday.
{
	const saturday = bj(2026, 9, 12, 10, 0);
	assert.equal(new Date(saturday + 8 * 3600 * 1000).getUTCDay(), 6, 'fixture must be a Saturday');
	const view = fold([...start(1, 0, saturday), message(1, 0, saturday, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })]);
	assert.equal(view.peak, false);
	assert.ok(Math.abs(view.cost - 1) < 1e-9, `expected 1, got ${view.cost}`);
	console.log('6 ok  weekend Saturday 10:00        ', view.cost.toFixed(6));
}

// 6b. The weekday rule is unconditional — an earlier Saturday inside a peak
//     window is off-peak too.
{
	const saturday = bj(2026, 8, 22, 10, 0);
	assert.equal(new Date(saturday + 8 * 3600 * 1000).getUTCDay(), 6, 'fixture must be a Saturday');
	const view = fold([...start(1, 0, saturday), message(1, 0, saturday, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	assert.equal(view.peak, false);
	assert.ok(Math.abs(view.cost - 1.5) < 1e-9, `expected legacy off-peak 1.5, got ${view.cost}`);
	console.log('6b ok earlier Saturday 10:00        ', view.cost.toFixed(6));
}

// 7. Non-official providers cost 0 but stay counted.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 1e6, 1e6), { provider: 'radeon', model: 'DeepSeek-V4-Flash' })]);
	assert.equal(view.cost, 0);
	assert.equal(view.freeCalls, 1);
	assert.equal(view.calls, 0);
	assert.equal(view.turnCost, 0);
	assert.equal(view.outputTokens, 1e6, 'non-official tokens remain visible');
	console.log('7 ok  non-official provider = 0     ', view.cost.toFixed(6));
}

// 8. Replacement: a second sample in one (turn, step) replaces the first.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
		message(1, 0, at, usage(2e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
	]);
	assert.equal(view.calls, 1);
	assert.equal(view.uncachedTokens, 2e6);
	assert.ok(Math.abs(view.cost - 2) < 1e-9, `expected 2, got ${view.cost}`);
	console.log('8 ok  in-step sample replacement    ', view.cost.toFixed(6));
}

// 9. Retry: llm/retry-started closes the slot, so the next attempt adds.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
		event('llm/retry', { turn: 1, step: 0 }, at),
		event('llm/retry-started', { turn: 1, step: 0 }, at),
		message(1, 0, at, usage(1e6, 1e6, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
	]);
	assert.equal(view.calls, 2);
	assert.equal(view.uncachedTokens, 2e6);
	// 1M uncached * 1 + (1M uncached * 1 + 1M output * 4)
	assert.ok(Math.abs(view.cost - 6) < 1e-9, `expected 6, got ${view.cost}`);
	console.log('9 ok  retry adds a billed attempt   ', view.cost.toFixed(6));
}

// 10. Turn boundaries reset the turn figures and keep the session totals.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
		event('step/end', { turn: 1, step: 0 }, at),
		event('turn/end', { turn: 1, reason: 'success' }, at),
		...start(2, 0, at),
		message(2, 0, at, usage(0, 1e6, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
	]);
	assert.equal(view.turn, 2);
	assert.ok(Math.abs(view.turnCost - 4) < 1e-9, `expected turn 4, got ${view.turnCost}`);
	assert.ok(Math.abs(view.cost - 5) < 1e-9, `expected session 5, got ${view.cost}`);
	console.log('10 ok turn reset / session kept     ', view.cost.toFixed(6), '/', view.turnCost.toFixed(6));
}

// 11. An attempt that names no route, preceded by a request/header, is attributed.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([
		...start(1, 0, at),
		event('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, reason: 'initial' }, at),
		event('assistant/attempt', { turn: 1, step: 0, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: usage(1e6, 0, 0) } }] }, at)
	]);
	assert.equal(view.calls, 1, 'attributed through the remembered route');
	assert.ok(Math.abs(view.cost - 1) < 1e-9, `expected 1, got ${view.cost}`);
	console.log('11 ok remembered route              ', view.cost.toFixed(6));
}

// 12. The wire value always passes its own schema, and state always passes the state schema.
{
	const at = bj(2026, 9, 11, 20, 0);
	let state = unit.init();
	unit.stateSchema.parse(state);
	for (const e of [...start(1, 0, at), message(1, 0, at, usage(10, 20, 30, 40), { provider: 'deepseek-official', model: 'deepseek-flash' })]) {
		state = unit.apply(state, e);
		unit.stateSchema.parse(state);
		unit.wire.viewSchema.parse(unit.wire.view(state));
	}
	assert.equal(typeof unit.wire.view(state).turns['1'].cost, 'number', 'the ledger rides the wire');
	assert.throws(() => unit.stateSchema.parse({ ...state, turns: { 1: { cost: 'free' } } }), /turns/);
	assert.throws(() => unit.stateSchema.parse({ ...state, turns: [] }), /turns/);
	assert.throws(() => unit.wire.viewSchema.parse({ ...unit.wire.view(state), turns: { 1: { cost: 1 } } }), /turns/);
	assert.deepEqual(Object.keys(unit.wire.view(state)).sort(), [
		'at',
		'cacheReadCost',
		'cacheReadTokens',
		'cacheWriteCost',
		'cacheWriteTokens',
		'calls',
		'cost',
		'currency',
		'estCost',
		'freeCalls',
		'model',
		'outputCost',
		'outputTokens',
		'peak',
		'provider',
		'turn',
		'turnCacheReadCost',
		'turnCacheReadTokens',
		'turnCacheWriteCost',
		'turnCacheWriteTokens',
		'turnCalls',
		'turnCost',
		'turnEstCost',
		'turnFreeCalls',
		'turnOutputCost',
		'turnOutputTokens',
		'turnUncachedCost',
		'turnUncachedTokens',
		'turnUnpricedCalls',
		'turns',
		'uncachedCost',
		'uncachedTokens',
		'unpricedCalls'
	]);
	console.log('12 ok schemas hold on every step');
}

// 13. A non-official route that reports no cache reads at all is estimated at the
//     assumed 95% cache-hit rate — not at the far costlier all-miss reading.
{
	const at = bj(2026, 9, 20, 20, 0);
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 1e6, 0), { provider: 'radeon', model: 'DeepSeek-V4-Flash' })
	]);
	assert.equal(view.cost, 0, 'a third-party route is billed 0');
	assert.equal(view.freeCalls, 1);
	// 1M prompt split 5% miss (¥1/M) + 95% hit (¥0.02/M), plus 1M output (¥4/M).
	const expected = 1e6 * 0.05 * (1 / 1e6) + 1e6 * 0.95 * (0.02 / 1e6) + 1e6 * (4 / 1e6);
	assert.ok(Math.abs(view.estCost - expected) < 1e-9, `expected ${expected}, got ${view.estCost}`);
	assert.ok(Math.abs(view.turnEstCost - expected) < 1e-9, 'the current turn carries its own estimate');
	console.log('13 ok no cache reported -> 95%      ', view.estCost.toFixed(6));
}

// 13b. The all-miss reading it replaces would have cost far more on the prompt
//      side, so the assumption is the load-bearing part of the estimate. (Output
//      is priced identically either way, so the comparison isolates the prompt.)
{
	const at = bj(2026, 9, 20, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 0, 0), { provider: 'radeon', model: 'DeepSeek-V4-Flash' })]);
	const allMiss = 1e6 * (1 / 1e6);
	assert.ok(view.estCost < allMiss / 10, `${view.estCost} should be far below the all-miss ${allMiss}`);
	console.log('13b ok well below the all-miss read ', `${view.estCost.toFixed(6)} vs ${allMiss.toFixed(2)}`);
}

// 14. A route that does report cache reads is estimated at its actual rate.
{
	const at = bj(2026, 9, 20, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(500000, 0, 500000), { provider: 'csu', model: 'DeepSeek' })]);
	// 1M prompt split 50/50, no output.
	const expected = 1e6 * 0.5 * (1 / 1e6) + 1e6 * 0.5 * (0.02 / 1e6);
	assert.ok(Math.abs(view.estCost - expected) < 1e-9, `expected ${expected}, got ${view.estCost}`);
	const assumed = 1e6 * 0.05 * (1 / 1e6) + 1e6 * 0.95 * (0.02 / 1e6);
	assert.ok(Math.abs(view.estCost - assumed) > 1e-9, 'the assumed rate must not be applied when one is reported');
	console.log('14 ok reported rate used as-is      ', view.estCost.toFixed(6));
}

// 15. A Pro-shaped id references the Pro tier; anything else references Flash.
{
	const at = bj(2026, 9, 20, 20, 0);
	const pro = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 0, 0), { provider: 'csu', model: 'DeepSeek-V4-Pro' })]);
	const expected = 1e6 * 0.05 * (4.5 / 1e6) + 1e6 * 0.95 * (0.15 / 1e6);
	assert.ok(Math.abs(pro.estCost - expected) < 1e-9, `expected ${expected}, got ${pro.estCost}`);
	// A model from another family has no official tier of its own, so it falls
	// back to the cheapest official rate.
	const qwen = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 0, 0), { provider: 'csu', model: 'Qwen' })]);
	const flash = 1e6 * 0.05 * (1 / 1e6) + 1e6 * 0.95 * (0.02 / 1e6);
	assert.ok(Math.abs(qwen.estCost - flash) < 1e-9, `expected flash reference ${flash}, got ${qwen.estCost}`);
	console.log('15 ok pro vs flash reference        ', pro.estCost.toFixed(6), '/', qwen.estCost.toFixed(6));
}

// 16. The official route carries no estimate: its real cost is the exact answer.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 1e6, 0), { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	assert.equal(view.estCost, 0);
	assert.equal(view.turnEstCost, 0);
	assert.equal(view.freeCalls, 0);
	console.log('16 ok official route is not estimated');
}

// 17. The estimate obeys the same replacement and retry rules as the real cost.
{
	const at = bj(2026, 9, 20, 20, 0);
	const route = { provider: 'radeon', model: 'DeepSeek-V4-Flash' };
	const one = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 0, 0), route)]);
	const replaced = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), route),
		message(1, 0, at, usage(2e6, 0, 0), route)
	]);
	assert.equal(replaced.freeCalls, 1, 'the replaced sample is withdrawn, not added');
	assert.ok(Math.abs(replaced.estCost - 2 * one.estCost) < 1e-9, 'the estimate tracks the surviving 2M sample');

	const retried = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), route),
		event('llm/retry', { turn: 1, step: 0 }, at),
		event('llm/retry-started', { turn: 1, step: 0 }, at),
		message(1, 0, at, usage(1e6, 0, 0), route)
	]);
	assert.equal(retried.freeCalls, 2, 'both billed attempts count');
	assert.ok(Math.abs(retried.estCost - 2 * one.estCost) < 1e-9, 'both attempts are estimated');
	console.log('17 ok replacement + retry           ', replaced.estCost.toFixed(6), '/', retried.estCost.toFixed(6));
}

// 18. The estimate follows the same peak multiplier as the real cost.
{
	const peak = bj(2026, 9, 18, 10, 0);
	const offPeak = bj(2026, 9, 18, 20, 0);
	assert.notEqual(new Date(peak + 8 * 3600 * 1000).getUTCDay() % 6, 0, 'fixture must be a weekday');
	const buckets = usage(1e6, 1e6, 0);
	const high = fold([...start(1, 0, peak), message(1, 0, peak, buckets, { provider: 'radeon', model: 'DeepSeek-V4-Flash' })]);
	const low = fold([...start(1, 0, offPeak), message(1, 0, offPeak, buckets, { provider: 'radeon', model: 'DeepSeek-V4-Flash' })]);
	assert.ok(Math.abs(high.estCost - 2 * low.estCost) < 1e-9, `peak ${high.estCost} should be twice off-peak ${low.estCost}`);
	console.log('18 ok peak multiplier applies       ', high.estCost.toFixed(6), '/', low.estCost.toFixed(6));
}

// 19. The per-turn ledger keeps every finished turn's own cost, so the built-in
//     usage dialog of turn 1 still answers after turn 2 reset the current-turn
//     figures.
{
	const at = bj(2026, 9, 11, 20, 0);
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
		event('turn/end', { turn: 1, reason: 'success' }, at),
		...start(2, 0, at),
		message(2, 0, at, usage(0, 1e6, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
	]);
	assert.deepEqual(Object.keys(view.turns).sort(), ['1', '2']);
	assert.ok(Math.abs(view.turns['1'].cost - 1) < 1e-9, `expected turn 1 = 1, got ${view.turns['1'].cost}`);
	assert.ok(Math.abs(view.turns['2'].cost - 4) < 1e-9, `expected turn 2 = 4, got ${view.turns['2'].cost}`);
	assert.equal(view.turns['2'].cost, view.turnCost, 'the ledger agrees with the current-turn figure');
	assert.ok(Math.abs(view.cost - 5) < 1e-9, 'and the session total is their sum');
	console.log('19 ok per-turn ledger                ', view.turns['1'].cost.toFixed(6), '/', view.turns['2'].cost.toFixed(6));
}

// 19b. Replacement and retry rewrite only the ledger entry of the turn they
//      belong to, and the estimate is ledgered beside the real cost.
{
	const at = bj(2026, 9, 20, 20, 0);
	const route = { provider: 'radeon', model: 'DeepSeek-V4-Flash' };
	const view = fold([
		...start(1, 0, at),
		message(1, 0, at, usage(1e6, 0, 0), route),
		message(1, 0, at, usage(2e6, 0, 0), route), // replaces the sample above
		event('llm/retry', { turn: 1, step: 0 }, at),
		event('llm/retry-started', { turn: 1, step: 0 }, at),
		message(1, 0, at, usage(2e6, 0, 0), route), // the retry adds
		event('turn/end', { turn: 1, reason: 'success' }, at),
		...start(2, 0, at),
		message(2, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
	]);
	assert.equal(view.turns['1'].cost, 0, 'a non-official turn bills 0');
	// 1M prompt at the assumed 95% hit rate, surviving sample doubled by retry.
	const one = 1e6 * 0.05 * (1 / 1e6) + 1e6 * 0.95 * (0.02 / 1e6);
	assert.ok(Math.abs(view.turns['1'].estCost - 4 * one) < 1e-9, `expected ${4 * one}, got ${view.turns['1'].estCost}`);
	assert.equal(view.turnEstCost, 0, 'the current turn is now turn 2, which carries no estimate');
	assert.ok(Math.abs(view.turns['2'].cost - 1) < 1e-9, 'the official turn ledgers its own cost');
	assert.equal(view.turns['2'].cost, view.turnCost, 'the ledger agrees with the current-turn figure');
	assert.equal(view.turns['2'].estCost, 0, 'and carries no estimate');
	console.log('19b ok ledger under replace + retry  ', view.turns['1'].estCost.toFixed(6), '/', view.turns['2'].cost.toFixed(6));
}

// 20. The desktop's "DeepSeek 账号" mode (`deepseek-account`) is DeepSeek's own
//     provider on the same upstream as the API-key route (`deepseek-official`),
//     so identical usage prices identically — never billed 0, never estimated.
{
	const at = bj(2026, 10, 13, 20, 0);
	const buckets = usage(508902, 226133, 107143424, 4096);
	const official = fold([...start(1, 0, at), message(1, 0, at, buckets, { provider: 'deepseek-official', model: 'deepseek-flash' })]);
	const account = fold([...start(1, 0, at), message(1, 0, at, buckets, { provider: 'deepseek-account', model: 'deepseek-flash' })]);
	assert.ok(official.cost > 0, 'the fixture must actually be billable');
	assert.equal(account.cost, official.cost, 'the two DeepSeek routes cost the same');
	assert.equal(account.calls, 1);
	assert.equal(account.freeCalls, 0, 'the account route is not an unbilled route');
	assert.equal(account.estCost, 0, 'and carries no what-if');
	assert.equal(account.turns['1'].cost, account.cost, 'the per-turn ledger prices it too');
	assert.equal(account.provider, 'deepseek-account');
	// The Pro tier is reached through the account route as well.
	const pro = fold([...start(1, 0, at), message(1, 0, at, usage(1e6, 0, 0), { provider: 'deepseek-account', model: 'deepseek-v4-pro' })]);
	assert.ok(Math.abs(pro.cost - 4.5) < 1e-9, `expected the Pro miss rate 4.5, got ${pro.cost}`);
	console.log('20 ok deepseek-account == official   ', account.cost.toFixed(6), '/', pro.cost.toFixed(6));
}

console.log('\nall checks passed');
