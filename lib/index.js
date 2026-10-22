/**
 * Host half of `dsh-deepseek-cost`.
 *
 * Registers the `deepseekCost` session projection: a whole-log fold that prices
 * every billed model attempt at DeepSeek's official peak/off-peak API rates.
 * Only routes served by DeepSeek's own providers are priced — the API-key route
 * and the signed-in account route alike; every other provider (a third-party
 * host of a DeepSeek model included) is billed as 0, while its token counts stay
 * visible so the absence of cost is explicit.
 *
 * The fold mirrors token-meter's `tokenUsage` replacement rule: the last usage
 * sample inside one (turn, step) replaces its predecessor, and
 * `llm/retry-started` closes that slot so a retried attempt adds instead.
 *
 * Besides the session and current-turn totals, the fold keeps a per-turn ledger
 * so each finished turn's cost stays answerable after a later `turn/start` has
 * reset the current-turn figures.
 *
 * @module dsh-deepseek-cost
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis plugin name. */
const name = 'deepseek-cost';
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
const inject = ['sessionProjections'];

/**
 * Provider routes billed as "DeepSeek official". Any other provider costs 0.
 *
 * `deepseek-official` is the API-key route and `deepseek-account` the signed-in
 * account route — the desktop's "DeepSeek 账号" mode. Both are registered by
 * DeepSeek's own LLM plugins against one shared Messages transport, so they
 * reach the same upstream at the same prices; only the credential differs. The
 * bare `deepseek` is a legacy alias kept for older logs.
 */
const OFFICIAL_PROVIDERS = ['deepseek-official', 'deepseek-account', 'deepseek'];

/** Milliseconds east of UTC for Beijing time, the zone DeepSeek prices in. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * One Beijing wall-clock instant as epoch milliseconds.
 * @param year - full year.
 * @param month - 1-based month.
 * @param day - day of month.
 * @param hour - hour of day, Beijing time.
 * @param minute - minute of hour.
 * @returns the epoch millisecond instant.
 */
function beijing(year, month, day, hour, minute) {
	return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

/**
 * Weekend days are not peak-chargeable; the two daily windows apply Monday
 * through Friday only. Source, and the rate table below:
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * The published rule reads "北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、
 * 14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段"
 * — statutory holidays are off-peak all day as well, so the weekday test alone
 * overcharges every holiday that falls on a weekday.
 */

/**
 * Chinese statutory holidays, as inclusive Beijing calendar-day ranges, when
 * DeepSeek charges the off-peak rate around the clock. Source: the State
 * Council's 2026 holiday notice, 国办发明电〔2025〕7号,
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * The notice's 调休 makeup workdays — weekend days it turns into working days —
 * are deliberately NOT peak. The published rule keys off 周一至周五 and states
 * that weekends are off-peak all day, so a Saturday stays off-peak however it is
 * worked; only the holiday ranges themselves leave the weekday rule.
 *
 * Only 2026 is published. A later year needs its own ranges added here, or its
 * holidays will be charged at peak until they are.
 */
const HOLIDAY_RANGES = [
	[2026, 1, 1, 2026, 1, 3], // 元旦
	[2026, 2, 15, 2026, 2, 23], // 春节
	[2026, 4, 4, 2026, 4, 6], // 清明节
	[2026, 5, 1, 2026, 5, 5], // 劳动节
	[2026, 6, 19, 2026, 6, 21], // 端午节
	[2026, 9, 25, 2026, 9, 27], // 中秋节
	[2026, 10, 1, 2026, 10, 7] // 国庆节
];

/** Milliseconds in one calendar day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Beijing calendar day one instant falls on, as a day index.
 * @param time - epoch milliseconds.
 * @returns whole days since the epoch, counted in Beijing time.
 */
function beijingDay(time) {
	return Math.floor((time + BEIJING_OFFSET_MS) / DAY_MS);
}

/** Every holiday day, expanded from {@link HOLIDAY_RANGES} for a constant-time test. */
const HOLIDAYS = new Set();
for (const [fromYear, fromMonth, fromDay, toYear, toMonth, toDay] of HOLIDAY_RANGES) {
	for (let day = beijingDay(beijing(fromYear, fromMonth, fromDay, 0, 0)), last = beijingDay(beijing(toYear, toMonth, toDay, 0, 0)); day <= last; day += 1) {
		HOLIDAYS.add(day);
	}
}

/**
 * Price tiers in CNY per 1,000,000 tokens at OFF-PEAK rates, newest last; the
 * last tier whose `from` has passed wins. Peak windows charge exactly twice
 * every rate.
 */
const FLASH_TIERS = [
	{ from: beijing(2026, 8, 17, 0, 0), cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
	{ from: beijing(2026, 9, 10, 12, 0), cacheHit: 0.02, cacheMiss: 1, output: 4 }
];
const PRO_TIERS = [{ from: beijing(2026, 8, 17, 0, 0), cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }];

/**
 * Model id → off-peak tier list. A model absent here is billed 0. The two
 * retired Flash aliases are still callable and are served — and billed — as
 * `deepseek-flash`, so they share its tiers.
 */
const PRICE_BOOK = {
	'deepseek-flash': FLASH_TIERS,
	'deepseek-v4-flash': FLASH_TIERS,
	'deepseek-v4-flash-vision-exp': FLASH_TIERS,
	'deepseek-v4-pro': PRO_TIERS
};

/** Currency the published rates are quoted in. */
const CURRENCY = 'CNY';

/**
 * Whether one instant falls in a DeepSeek peak window: Beijing 09:00–12:00 or
 * 14:00–18:00 on a weekday that is not a statutory holiday.
 * @param time - epoch milliseconds of the request.
 * @returns true when the peak multiplier applies.
 */
function isPeak(time) {
	const shifted = new Date(time + BEIJING_OFFSET_MS);
	const day = shifted.getUTCDay();
	if (day === 0 || day === 6) return false;
	if (HOLIDAYS.has(beijingDay(time))) return false;
	const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
	return (minute >= 9 * 60 && minute < 12 * 60) || (minute >= 14 * 60 && minute < 18 * 60);
}

/**
 * Resolve the off-peak tier in force for one model at one instant.
 * @param model - provider-owned model id.
 * @param time - epoch milliseconds of the request.
 * @returns the tier, or undefined when the model has no published rate.
 */
function tierFor(model, time) {
	const tiers = PRICE_BOOK[model];
	if (tiers === undefined) return undefined;
	let chosen;
	for (const tier of tiers) if (time >= tier.from) chosen = tier;
	return chosen;
}

/**
 * Price one attempt's token buckets.
 * @param provider - billed provider route.
 * @param model - billed model id.
 * @param buckets - prompt/output buckets, cache write charged at the miss rate.
 * @param time - epoch milliseconds of the request.
 * @returns per-bucket CNY amounts plus `peak`, or undefined when unpriceable.
 */
function priceAttempt(provider, model, buckets, time) {
	if (!OFFICIAL_PROVIDERS.includes(provider)) return undefined;
	const tier = tierFor(model, time);
	if (tier === undefined) return undefined;
	const peak = isPeak(time);
	const factor = peak ? 2 : 1;
	const perCacheHit = (tier.cacheHit * factor) / 1e6;
	const perCacheMiss = (tier.cacheMiss * factor) / 1e6;
	const perOutput = (tier.output * factor) / 1e6;
	return {
		uncachedCost: buckets.uncached * perCacheMiss,
		cacheReadCost: buckets.cacheRead * perCacheHit,
		cacheWriteCost: buckets.cacheWrite * perCacheMiss,
		outputCost: buckets.output * perOutput,
		peak
	};
}

/**
 * Cache-hit share assumed for an estimated attempt that reports no cache reads
 * of its own. Third-party routes frequently report none at all, and an agent
 * session re-sends almost its whole prompt every step, so reading a reported
 * zero literally would price the entire prompt at the far more expensive
 * cache-miss rate. 95% is the shape a real session settles into.
 */
const ASSUMED_CACHE_HIT_RATE = 0.95;

/**
 * Normalize a model id for shape comparison: lowercase, separators dropped.
 * @param model - provider-owned model id.
 * @returns the comparable form.
 */
function normalizeModelId(model) {
	return model.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The official model whose published rates stand in for a non-official route's
 * model. Anything whose id names a Pro model references Pro; everything else —
 * a Flash alias, a DeepSeek id of unknown version, or a model from another
 * family entirely — references Flash, the cheapest official rate and so the
 * conservative choice.
 * @param model - provider-owned model id.
 * @returns an id present in the price book.
 */
function referenceModelFor(model) {
	return normalizeModelId(model).includes('pro') ? 'deepseek-v4-pro' : 'deepseek-flash';
}

/**
 * Estimate what one non-official route's attempt would have cost at official
 * rates. The official route needs no estimate — its real cost is already priced
 * — as does an attempt that reported no tokens at all.
 *
 * The whole prompt is re-split by cache-hit rate rather than read bucket by
 * bucket, because that split is the one premise the estimate rests on: a
 * reported rate of zero is replaced by {@link ASSUMED_CACHE_HIT_RATE}, and any
 * other reported rate is taken as it stands.
 * @param provider - billed provider route.
 * @param model - billed model id.
 * @param buckets - prompt/output buckets as the route reported them.
 * @param time - epoch milliseconds of the request.
 * @returns the estimated CNY total plus `peak`, or undefined when not estimable.
 */
function estimateAttempt(provider, model, buckets, time) {
	if (OFFICIAL_PROVIDERS.includes(provider)) return undefined;
	const tier = tierFor(referenceModelFor(model), time);
	if (tier === undefined) return undefined;
	const prompt = buckets.uncached + buckets.cacheRead + buckets.cacheWrite;
	if (prompt === 0 && buckets.output === 0) return undefined;
	const peak = isPeak(time);
	const factor = peak ? 2 : 1;
	const perCacheHit = (tier.cacheHit * factor) / 1e6;
	const perCacheMiss = (tier.cacheMiss * factor) / 1e6;
	const perOutput = (tier.output * factor) / 1e6;
	const reported = prompt === 0 ? 0 : buckets.cacheRead / prompt;
	const hitRate = reported === 0 ? ASSUMED_CACHE_HIT_RATE : reported;
	return {
		cost: prompt * (1 - hitRate) * perCacheMiss + prompt * hitRate * perCacheHit + buckets.output * perOutput,
		peak
	};
}

/**
 * Non-negative safe count.
 * @param value - candidate.
 * @returns whether the value is a usable token count.
 */
function isCount(value) {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The usage one durable event reports for its attempt, if any: the settlement's
 * own `usage` first, otherwise the last usage chunk embedded in its stream.
 * @param event - a committed assistant event.
 * @returns the usage record, or undefined.
 */
function usageOf(event) {
	if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage;
	const stream = event.data.stream;
	if (!Array.isArray(stream)) return undefined;
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const record = stream[index];
		if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) return record.chunk.usage;
	}
	return undefined;
}

/**
 * Token buckets of one usage record, or undefined when the record is unusable.
 * @param usage - provider-reported usage.
 * @returns normalised buckets carrying provider-reported values only.
 */
function bucketsOf(usage) {
	if (typeof usage !== 'object' || usage === null) return undefined;
	const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
	if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined;
	if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined;
	if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined;
	return {
		uncached: inputTokens,
		output: outputTokens,
		cacheRead: cacheReadTokens ?? 0,
		cacheWrite: cacheWriteTokens ?? 0
	};
}

/**
 * The route one event names, when it names one.
 * @param event - a committed session event.
 * @returns provider/model, or undefined.
 */
function routeOf(event) {
	if (event.type === 'assistant/message') {
		const source = event.data.message?.source;
		if (typeof source?.provider === 'string' && source.provider.length > 0 && typeof source.model === 'string' && source.model.length > 0) {
			return { provider: source.provider, model: source.model };
		}
		return undefined;
	}
	if (event.type === 'request/context') {
		const { provider, model } = event.data;
		if (typeof provider === 'string' && typeof model === 'string' && provider.length > 0 && model.length > 0) return { provider, model };
		return undefined;
	}
	if (event.type === 'request/header') {
		const config = event.data.header?.config;
		const provider = config?.provider;
		const model = config?.model;
		if (typeof provider === 'string' && typeof model === 'string' && provider.length > 0 && model.length > 0) return { provider, model };
	}
	return undefined;
}

/**
 * Zeroed session totals (the display-independent half of the fold state).
 *
 * `turns` is the per-turn ledger: one entry per turn that metered anything,
 * keyed by the turn number DSH stamps on `turn/start` and on a completed turn's
 * footer. A finished turn is never the current turn again, yet its usage dialog
 * stays openable from the transcript, so the turn's own cost has to outlive the
 * current-turn figures — which `turn/start` resets on every boundary.
 */
const zeroTotals = () => ({
	cost: 0,
	uncachedCost: 0,
	cacheReadCost: 0,
	cacheWriteCost: 0,
	outputCost: 0,
	uncachedTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 0,
	calls: 0,
	freeCalls: 0,
	unpricedCalls: 0,
	estCost: 0,
	turns: {}
});

/** Zeroed per-turn ledger entry. */
const zeroTurnCost = () => ({ cost: 0, estCost: 0 });

/**
 * The ledger with one contribution added to (or withdrawn from) one turn.
 * @param turns - current per-turn ledger.
 * @param contribution - the priced attempt being added or replaced.
 * @param sign - +1 to add, -1 to withdraw the superseded sample.
 * @returns the next ledger, sharing every untouched entry.
 */
function applyTurnCost(turns, contribution, sign) {
	const key = String(contribution.turn);
	const prior = turns[key] ?? zeroTurnCost();
	return {
		...turns,
		[key]: {
			cost: prior.cost + sign * contribution.cost,
			estCost: prior.estCost + sign * contribution.estCost
		}
	};
}

/** Zeroed current-turn totals. */
const zeroTurn = () => ({
	turn: 0,
	turnCost: 0,
	turnUncachedCost: 0,
	turnCacheReadCost: 0,
	turnCacheWriteCost: 0,
	turnOutputCost: 0,
	turnEstCost: 0,
	turnUncachedTokens: 0,
	turnCacheReadTokens: 0,
	turnCacheWriteTokens: 0,
	turnOutputTokens: 0,
	turnCalls: 0,
	turnFreeCalls: 0,
	turnUnpricedCalls: 0
});

/**
 * Apply one priced contribution to the flat totals, or its negation when the
 * sample it replaced must be withdrawn first.
 * @param state - current fold state.
 * @param contribution - the priced attempt being added or replaced.
 * @param sign - +1 to add, -1 to withdraw the superseded sample.
 * @returns the flat totals patch, ledger included.
 */
function applyContribution(state, contribution, sign) {
	const buckets = contribution.buckets;
	return {
		cost: state.cost + sign * contribution.cost,
		uncachedCost: state.uncachedCost + sign * contribution.uncachedCost,
		cacheReadCost: state.cacheReadCost + sign * contribution.cacheReadCost,
		cacheWriteCost: state.cacheWriteCost + sign * contribution.cacheWriteCost,
		outputCost: state.outputCost + sign * contribution.outputCost,
		estCost: state.estCost + sign * contribution.estCost,
		uncachedTokens: state.uncachedTokens + sign * buckets.uncached,
		cacheReadTokens: state.cacheReadTokens + sign * buckets.cacheRead,
		cacheWriteTokens: state.cacheWriteTokens + sign * buckets.cacheWrite,
		outputTokens: state.outputTokens + sign * buckets.output,
		calls: state.calls + sign * contribution.calls,
		freeCalls: state.freeCalls + sign * contribution.freeCalls,
		unpricedCalls: state.unpricedCalls + sign * contribution.unpricedCalls,
		turnCost: state.turnCost + sign * contribution.cost,
		turnUncachedCost: state.turnUncachedCost + sign * contribution.uncachedCost,
		turnCacheReadCost: state.turnCacheReadCost + sign * contribution.cacheReadCost,
		turnCacheWriteCost: state.turnCacheWriteCost + sign * contribution.cacheWriteCost,
		turnOutputCost: state.turnOutputCost + sign * contribution.outputCost,
		turnEstCost: state.turnEstCost + sign * contribution.estCost,
		turnUncachedTokens: state.turnUncachedTokens + sign * buckets.uncached,
		turnCacheReadTokens: state.turnCacheReadTokens + sign * buckets.cacheRead,
		turnCacheWriteTokens: state.turnCacheWriteTokens + sign * buckets.cacheWrite,
		turnOutputTokens: state.turnOutputTokens + sign * buckets.output,
		turnCalls: state.turnCalls + sign * contribution.calls,
		turnFreeCalls: state.turnFreeCalls + sign * contribution.freeCalls,
		turnUnpricedCalls: state.turnUnpricedCalls + sign * contribution.unpricedCalls,
		turns: applyTurnCost(state.turns, contribution, sign)
	};
}

/**
 * Round a CNY amount to the wire's 6-decimal precision, keeping the value a
 * plain JSON number and suppressing float noise in the displayed digits.
 * @param value - raw amount.
 * @returns the rounded amount.
 */
function money(value) {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Round every amount in the per-turn ledger to the wire's precision.
 * @param turns - current per-turn ledger.
 * @returns the ledger as published.
 */
function ledgerWire(turns) {
	const out = {};
	for (const [key, entry] of Object.entries(turns)) out[key] = { cost: money(entry.cost), estCost: money(entry.estCost) };
	return out;
}

/**
 * Build the client wire value from the current fold state.
 * @param state - current fold state.
 * @returns the wire payload.
 */
function wireOf(state) {
	return {
		currency: CURRENCY,
		cost: money(state.cost),
		uncachedCost: money(state.uncachedCost),
		cacheReadCost: money(state.cacheReadCost),
		cacheWriteCost: money(state.cacheWriteCost),
		outputCost: money(state.outputCost),
		estCost: money(state.estCost),
		uncachedTokens: state.uncachedTokens,
		cacheReadTokens: state.cacheReadTokens,
		cacheWriteTokens: state.cacheWriteTokens,
		outputTokens: state.outputTokens,
		calls: state.calls,
		freeCalls: state.freeCalls,
		unpricedCalls: state.unpricedCalls,
		turns: ledgerWire(state.turns),
		turn: state.turn,
		turnCost: money(state.turnCost),
		turnUncachedCost: money(state.turnUncachedCost),
		turnCacheReadCost: money(state.turnCacheReadCost),
		turnCacheWriteCost: money(state.turnCacheWriteCost),
		turnOutputCost: money(state.turnOutputCost),
		turnEstCost: money(state.turnEstCost),
		turnUncachedTokens: state.turnUncachedTokens,
		turnCacheReadTokens: state.turnCacheReadTokens,
		turnCacheWriteTokens: state.turnCacheWriteTokens,
		turnOutputTokens: state.turnOutputTokens,
		turnCalls: state.turnCalls,
		turnFreeCalls: state.turnFreeCalls,
		turnUnpricedCalls: state.turnUnpricedCalls,
		peak: state.peak,
		at: state.at,
		provider: state.provider,
		model: state.model
	};
}

/** The fold state's initial value, wire view included. */
function initialState() {
	const base = { ...zeroTotals(), ...zeroTurn(), peak: false, at: 0, provider: '', model: '', slot: null, route: null };
	return { ...base, client: wireOf(base) };
}

/** Runtime shape check for one non-negative finite number. */
const NUM = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
/** Runtime shape check for one nullable object slot. */
const NULLABLE = (value) => value === null || (typeof value === 'object' && value !== null);

/**
 * Runtime shape check for a per-turn ledger: a plain record of turn numbers
 * onto `{cost, estCost}` amounts. Used by both boundaries, which persist and
 * publish the same shape.
 * @param value - candidate ledger.
 * @returns whether the value is a usable ledger.
 */
function isLedger(value) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	for (const entry of Object.values(value)) {
		if (typeof entry !== 'object' || entry === null) return false;
		if (!NUM(entry.cost) || !NUM(entry.estCost)) return false;
	}
	return true;
}

/**
 * The persisted-state boundary: only `.parse` is ever consulted by the
 * projection registry, so a plain validator stands in for a schema library and
 * keeps this package dependency-free.
 */
const stateSchema = {
	parse(value) {
		if (typeof value !== 'object' || value === null) throw new TypeError('deepseekCost state must be an object');
		for (const key of [
			'cost',
			'uncachedCost',
			'cacheReadCost',
			'cacheWriteCost',
			'outputCost',
			'estCost',
			'uncachedTokens',
			'cacheReadTokens',
			'cacheWriteTokens',
			'outputTokens',
			'calls',
			'freeCalls',
			'unpricedCalls',
			'turn',
			'turnCost',
			'turnUncachedCost',
			'turnCacheReadCost',
			'turnCacheWriteCost',
			'turnOutputCost',
			'turnEstCost',
			'turnUncachedTokens',
			'turnCacheReadTokens',
			'turnCacheWriteTokens',
			'turnOutputTokens',
			'turnCalls',
			'turnFreeCalls',
			'turnUnpricedCalls',
			'at'
		]) {
			if (!NUM(value[key])) throw new TypeError(`deepseekCost state.${key} must be a non-negative finite number`);
		}
		if (typeof value.peak !== 'boolean') throw new TypeError('deepseekCost state.peak must be a boolean');
		if (!isLedger(value.turns)) throw new TypeError('deepseekCost state.turns must be a record of {cost, estCost} amounts');
		if (typeof value.provider !== 'string' || typeof value.model !== 'string') throw new TypeError('deepseekCost state route must be string');
		if (!NULLABLE(value.slot) || !NULLABLE(value.route)) throw new TypeError('deepseekCost state slots must be null or objects');
		if (typeof value.client !== 'object' || value.client === null) throw new TypeError('deepseekCost state.client must be an object');
		return value;
	}
};

/** The wire boundary: the client value as published. */
const viewSchema = {
	parse(value) {
		if (typeof value !== 'object' || value === null) throw new TypeError('deepseekCost view must be an object');
		if (value.currency !== CURRENCY) throw new TypeError('deepseekCost view.currency must be the published currency');
		for (const [key, entry] of Object.entries(value)) {
			if (key === 'currency' || key === 'provider' || key === 'model') {
				if (typeof entry !== 'string') throw new TypeError(`deepseekCost view.${key} must be a string`);
				continue;
			}
			if (key === 'peak') {
				if (typeof entry !== 'boolean') throw new TypeError('deepseekCost view.peak must be a boolean');
				continue;
			}
			if (key === 'turns') {
				if (!isLedger(entry)) throw new TypeError('deepseekCost view.turns must be a record of {cost, estCost} amounts');
				continue;
			}
			if (!NUM(entry)) throw new TypeError(`deepseekCost view.${key} must be a non-negative finite number`);
		}
		return value;
	}
};

/** The `deepseekCost` unit registered on `ctx.sessionProjections`. */
const deepseekCostProjectionDefinition = {
	key: 'deepseekCost',
	// 2 added the per-turn ledger; 3 added `deepseek-account` to the billed
	// routes; 4 corrected the billing-window label, which used to be read off
	// the priced path alone and so froze at the last official attempt's window.
	// A version bump is what makes an already-logged session refold: a
	// mismatched row is discarded and the log replays from seq 0, so a
	// correction to how the fold derives its state reaches history too.
	stateVersion: 4,
	stateSchema,
	init: initialState,
	apply: (state, event) => {
		const type = event.type;

		if (type === 'turn/start') {
			const turn = event.data.turn;
			const settled =
				turn === state.turn &&
				state.slot === null &&
				state.turnCost === 0 &&
				state.turnCalls === 0 &&
				state.turnFreeCalls === 0 &&
				state.turnUnpricedCalls === 0;
			if (settled) return state;
			const next = { ...state, ...zeroTurn(), turn, slot: null };
			return { ...next, client: wireOf(next) };
		}

		// Route snapshots carry no usage; remembering the latest one lets an
		// attempt that settles without a message still be attributed.
		if (type === 'request/header' || type === 'request/context') {
			const snapshot = routeOf(event);
			if (snapshot === undefined) return state;
			if (state.route !== null && state.route.provider === snapshot.provider && state.route.model === snapshot.model) return state;
			const next = { ...state, route: snapshot, provider: snapshot.provider, model: snapshot.model };
			return { ...next, client: wireOf(next) };
		}

		if (type === 'llm/retry-started') {
			const slot = state.slot;
			if (slot === null || slot.turn !== event.data.turn || slot.step !== event.data.step) return state;
			const next = { ...state, slot: null };
			return { ...next, client: wireOf(next) };
		}

		if (type !== 'assistant/message' && type !== 'assistant/attempt') return state;

		const usage = usageOf(event);
		if (usage === undefined) return state;
		const buckets = bucketsOf(usage);
		if (buckets === undefined) return state;

		const route = routeOf(event) ?? state.route ?? undefined;

		const { turn, step } = event.data;
		const previous = state.slot !== null && state.slot.turn === turn && state.slot.step === step ? state.slot : undefined;

		const priced = route === undefined ? undefined : priceAttempt(route.provider, route.model, buckets, event.time);
		const estimated = route === undefined ? undefined : estimateAttempt(route.provider, route.model, buckets, event.time);
		const contribution = {
			turn,
			step,
			buckets,
			cost: priced === undefined ? 0 : priced.uncachedCost + priced.cacheReadCost + priced.cacheWriteCost + priced.outputCost,
			uncachedCost: priced === undefined ? 0 : priced.uncachedCost,
			cacheReadCost: priced === undefined ? 0 : priced.cacheReadCost,
			cacheWriteCost: priced === undefined ? 0 : priced.cacheWriteCost,
			outputCost: priced === undefined ? 0 : priced.outputCost,
			// Only a non-official route carries an estimate; the official route's
			// real cost is already the exact answer.
			estCost: estimated === undefined ? 0 : estimated.cost,
			calls: priced === undefined ? 0 : 1,
			freeCalls: priced !== undefined || route === undefined ? 0 : 1,
			unpricedCalls: route === undefined ? 1 : 0,
			// The window label tracks the latest attempt that had a route, so it
			// names the window that attempt's own figures were priced in — both
			// pricing paths call `isPeak(event.time)`, so the label and the amounts
			// can never disagree about one attempt. Reading it off the priced path
			// alone froze it at the last OFFICIAL attempt's window, and a session
			// that had since moved to a peak third-party request kept reading
			// 空闲时段. No route at all leaves the previous window standing.
			peak: route === undefined ? undefined : isPeak(event.time)
		};

		// Withdraw the sample this (turn, step) already contributed, then add the
		// replacement — a retry closed the slot beforehand, so it adds instead.
		const withdrawn = previous === undefined ? state : { ...state, ...applyContribution(state, previous, -1) };
		const next = {
			...withdrawn,
			...applyContribution(withdrawn, contribution, 1),
			route: route ?? state.route,
			provider: route === undefined ? state.provider : route.provider,
			model: route === undefined ? state.model : route.model,
			peak: contribution.peak ?? state.peak,
			at: contribution.unpricedCalls === 0 ? event.time : state.at,
			slot: contribution
		};
		return { ...next, client: wireOf(next) };
	},
	wire: {
		viewSchema,
		view: (state) => state.client
	}
};

/**
 * Overwrite the one-line activation record this plugin keeps for diagnosis:
 * `$DSH_HOME` when set, else `~/.dsh`, then `dsh-deepseek-cost/boot.log`.
 * A failure here must never break activation, so it is swallowed.
 * @param detail - what this mount registered.
 */
function recordBoot(detail) {
	try {
		const configured = process.env.DSH_HOME;
		const home = typeof configured === 'string' && configured.trim().length > 0 ? configured.trim() : join(homedir(), '.dsh');
		const dir = join(home, 'dsh-deepseek-cost');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'boot.log'), `${new Date().toISOString()} host half mounted: ${detail}\n`);
	} catch {
		// Diagnostics are best effort.
	}
}

/**
 * Register the `deepseekCost` unit; the registration is an effect on this
 * plugin's fiber, so unloading removes the key and the client reads absence.
 * @param ctx - registrant context carrying the projection registry.
 */
function apply(ctx) {
	ctx.sessionProjections.register(deepseekCostProjectionDefinition);
	recordBoot('projection "deepseekCost" registered');
}

export { apply, deepseekCostProjectionDefinition, inject, name };
