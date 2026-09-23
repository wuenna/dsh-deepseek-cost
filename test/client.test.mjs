/**
 * Browser-half checks for dsh-deepseek-cost.
 *
 * Loads `lib/client.js` exactly the way the client module system does — through
 * `window.__ModuleLoader__.load` with a lazy-CJS factory — then renders the pill
 * and its dialog against a minimal React stand-in. React is a browser-side
 * static module in DSH and is not installed as a Node package here, so the stub
 * supplies `createElement`, `useState`/`useRef`/`useEffect` and the two
 * primitives hooks the pill consumes; the components under test use no other
 * React surface.
 *
 * Run with `node test/client.test.mjs` from the package root.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FRAGMENT = Symbol.for('react.fragment');

/** Hooks seam: the current case installs the state each hook should return. */
const hooks = { state: undefined, effect: undefined, effectFns: [], effects: 0 };

const React = {
	Fragment: FRAGMENT,
	createElement(type, props, ...children) {
		// React lifts `key`/`ref` out of props; mirror that so assertions see the
		// same attribute set the browser would.
		const { key, ref, ...rest } = props ?? {};
		const merged = { ...rest };
		if (children.length === 1) merged.children = children[0];
		else if (children.length > 1) merged.children = children;
		return { type, key, ref, props: merged };
	},
	useState(initial) {
		return [hooks.state ?? (typeof initial === 'function' ? initial() : initial), () => {}];
	},
	useRef(initial) {
		return { current: initial ?? null };
	},
	useEffect(fn) {
		hooks.effect = fn;
		hooks.effectFns.push(fn);
		hooks.effects += 1;
	}
};

/** Anchored placement the primitives stub hands back. */
const ANCHORED = { position: 'fixed', left: 10, top: 20 };
const dismissals = [];
const primitives = {
	useAnchoredPosition: (options) => {
		dismissals.push({ kind: 'anchor', options });
		return ANCHORED;
	},
	useDismissOnOutsidePointer: (rootRef, open, setOpen, panelRef) => {
		dismissals.push({ kind: 'dismiss', rootRef, open, setOpen, panelRef });
	}
};

/** Captured `__ModuleLoader__.load` registrations. */
const loaded = [];
globalThis.window = {
	__ModuleLoader__: {
		load: (registration) => loaded.push(registration)
	}
};

/**
 * Minimal document. The bundle injects its stylesheet at factory time and the
 * open pill portals into `document.body`, so the stub must answer both without a
 * real DOM; `querySelector` is reassigned per case to steer the dock's anchor.
 */
const injectedStyles = [];
globalThis.document = {
	body: { name: 'body' },
	head: { appendChild: () => {} },
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: '', setAttribute: () => {}, remove: () => {} }),
	addEventListener: () => {},
	removeEventListener: () => {}
};

await import('../lib/client.js');

assert.equal(loaded.length, 1, 'the bundle must register exactly one module');
assert.equal(loaded[0].id, 'dsh-deepseek-cost', 'the module id must be the package name');

/** Portals the current render opened. */
const portals = [];
const client = loaded[0].factory((request) => {
	if (request === 'react') return React;
	if (request === 'react-dom') {
		return {
			createPortal: (children, container) => {
				portals.push({ children, container });
				return { $$portal: container };
			}
		};
	}
	if (request === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
	throw new Error(`unexpected require(${JSON.stringify(request)})`);
});

assert.deepEqual(client.inject, ['slots', 'locale']);
const { CostDialog, CostDock, CostPill, USAGE_DETAILS, TURN_TAIL, formatAmount, formatEstimate, formatMoney, paintUsageRow, turnCostModel, useTurnUsageRow, zh, en } =
	client.__internals;

/** Serialize a stub-React element tree to HTML. */
function html(node) {
	const out = [];
	const walk = (current) => {
		if (current === null || current === undefined || typeof current === 'boolean') return;
		if (Array.isArray(current)) {
			for (const child of current) walk(child);
			return;
		}
		if (typeof current === 'string' || typeof current === 'number') {
			out.push(String(current));
			return;
		}
		const { type, props } = current;
		if (type === FRAGMENT) {
			walk(props.children);
			return;
		}
		if (typeof type === 'function') {
			walk(type(props));
			return;
		}
		const attributes = [];
		for (const [key, value] of Object.entries(props ?? {})) {
			if (key === 'children' || value === undefined || value === null || value === false) continue;
			if (key === 'style') {
				// React turns camelCase style keys into hyphenated CSS properties.
				const declarations = Object.entries(value).map(([name, entry]) => `${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${entry}`);
				attributes.push(`style="${declarations.join(';')}"`);
				continue;
			}
			// React's own prop names map onto different DOM attribute names.
			const attribute = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
			attributes.push(`${attribute}="${String(value)}"`);
		}
		out.push(`<${type}${attributes.length === 0 ? '' : ` ${attributes.join(' ')}`}>`);
		walk(props?.children);
		out.push(`</${type}>`);
	};
	walk(node);
	return out.join('');
}

/** Visible text of a serialized tree: tags and attributes stripped. */
const text = (markup) => markup.replace(/<[^>]*>/g, '');

/** Dictionary lookup standing in for the slot's locale seat. */
const seat = (dict) => (key, params) => {
	const template = dict[key] ?? key;
	return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
};

/**
 * Minimal element for the injected row: records its own children and attributes.
 * @param tagName - the element's tag.
 * @returns the element.
 */
function element(tagName) {
	return {
		tagName,
		className: '',
		textContent: '',
		attributes: {},
		children: [],
		setAttribute(name, value) {
			this.attributes[name] = String(value);
		},
		getAttribute(name) {
			return this.attributes[name] ?? null;
		},
		appendChild(child) {
			this.children.push(child);
			return child;
		}
	};
}

/** Serialize one of those elements, children included. */
function domHtml(node) {
	const attributes = Object.entries(node.attributes)
		.map(([name, value]) => ` ${name}="${value}"`)
		.join('');
	const className = node.className === '' ? '' : ` class="${node.className}"`;
	return `<${node.tagName}${className}${attributes}>${node.textContent}${node.children.map(domHtml).join('')}</${node.tagName}>`;
}

/**
 * The built-in turn-usage dialog as the browser presents it: a body-portaled
 * element whose `dl` is the row list this plugin appends to.
 * @returns the dialog and its row list.
 */
function usageDialog() {
	const details = element('dl');
	details.querySelector = (selector) => details.children.find((child) => child.getAttribute('data-deepseek-cost') === 'usage-turn') ?? null;
	const panel = {
		nodeType: 1,
		ownerDocument: { createElement: element },
		attributes: { role: 'dialog' },
		getAttribute(name) {
			return this.attributes[name] ?? null;
		},
		querySelector: (selector) => (selector === USAGE_DETAILS ? details : null)
	};
	return { panel, details };
}

/** A trigger whose turn footer carries `turn`, as a click target would see it. */
const clickedTrigger = (turn) => ({
	closest: (selector) =>
		selector === 'button[aria-haspopup="dialog"]'
			? { closest: (inner) => (inner === `[${TURN_TAIL}]` ? { getAttribute: (name) => (name === TURN_TAIL ? turn : null) } : null) }
			: null
});

// 1. Money formatting keeps whole amounts at two decimals, sub-yuan ones at four,
//    and separates the currency symbol from the figure with a space.
{
	assert.equal(formatAmount(0), '0.00');
	assert.equal(formatAmount(0.5), '0.5000');
	assert.equal(formatAmount(1.005), '1.00');
	assert.equal(formatAmount(12.3456), '12.35');
	assert.equal(formatMoney(0.4321, 'CNY'), '¥ 0.4321');
	assert.equal(formatMoney(12.3, 'CNY'), '¥ 12.30');
	assert.equal(formatMoney(undefined, 'CNY'), '¥ 0.00');
	assert.equal(formatMoney(3.5, 'XTS'), '3.50', 'a currency with no symbol renders bare');
	assert.equal(formatEstimate(0.165, 'CNY'), '~¥ 0.1650', 'an estimate is tilde-marked');
	console.log('1 ok  money formatting              ', formatMoney(0.4321, 'CNY'), '/', formatEstimate(0.165, 'CNY'));
}

const cost = {
	currency: 'CNY',
	cost: 0.4321,
	uncachedCost: 0.012,
	cacheReadCost: 0.0988,
	cacheWriteCost: 0,
	outputCost: 0.3213,
	estCost: 0.165,
	uncachedTokens: 12000,
	cacheReadTokens: 4940000,
	cacheWriteTokens: 0,
	outputTokens: 80325,
	calls: 7,
	freeCalls: 0,
	unpricedCalls: 0,
	turn: 3,
	turnCost: 0.0123,
	turnUncachedCost: 0.001,
	turnCacheReadCost: 0.0028,
	turnCacheWriteCost: 0,
	turnOutputCost: 0.0085,
	turnEstCost: 0.0165,
	turnUncachedTokens: 1000,
	turnCacheReadTokens: 140000,
	turnCacheWriteTokens: 0,
	turnOutputTokens: 2125,
	turnCalls: 1,
	turnFreeCalls: 0,
	turnUnpricedCalls: 0,
	peak: false,
	at: 0,
	provider: 'deepseek-official',
	model: 'deepseek-flash',
	// The per-turn ledger the built-in usage dialog is answered from: turn 3 is
	// the current turn and carries an estimate; turn 2 is a finished turn.
	turns: { 2: { cost: 0.5, estCost: 0 }, 3: { cost: 0.0123, estCost: 0.0165 } }
};

// 2. The pill shows the currency mark exactly once in its visible text, then bare
//    amounts; the accessible name and tooltip still carry a symbol per figure.
{
	hooks.state = false;
	const markup = html(React.createElement(CostPill, { cost, t: seat(zh) }));
	assert.match(markup, /class="dcost_icon"[^>]*>¥<\/span>/, 'the currency mark is the pill icon');
	const label = /class="dcost_label">([\s\S]*?)<\/span><\/button>/.exec(markup);
	assert.notEqual(label, null);
	assert.equal(label[1].includes('¥'), false, 'the amounts beside the icon stay bare');
	assert.match(label[1], /^0\.4321<span class="dcost_sep"[^>]*>·<\/span>本轮 0\.0123$/);
	assert.match(markup, /空闲时段/, 'the tooltip states the billing window');
	assert.match(markup, /aria-label="会话花费 ¥ 0\.4321，本轮花费 ¥ 0\.0123"/);
	const markupEn = html(React.createElement(CostPill, { cost, t: seat(en) }));
	assert.equal((/class="dcost_label">([\s\S]*?)<\/span><\/button>/.exec(markupEn)[1].includes('¥')), false);
	assert.match(markupEn, /this turn 0\.0123/);
	// The visible label stays clean; the estimate rides in the tooltip only.
	assert.equal(label[1].includes('预估'), false, 'the pill label is not cluttered with the estimate');
	const withFree = html(React.createElement(CostPill, { cost: { ...cost, freeCalls: 3 }, t: seat(zh) }));
	assert.match(withFree, /title="[^"]*· 预估 ~¥ 0\.1650"/, 'the tooltip carries the estimate when one exists');
	assert.match(html(React.createElement(CostPill, { cost, t: seat(zh) })), /title="[^"]*（空闲时段）"/);
	console.log('2 ok  one visible currency mark     ', `¥${label[1].replace(/<[^>]*>/g, '')}`);
}

// 3. A closed pill portals nothing; an open one portals its dialog.
{
	portals.length = 0;
	dismissals.length = 0;
	hooks.effect = undefined;
	hooks.state = false;
	html(React.createElement(CostPill, { cost, t: seat(zh) }));
	assert.equal(portals.length, 0, 'closed pill renders no dialog');

	portals.length = 0;
	hooks.state = true;
	html(React.createElement(CostPill, { cost, t: seat(zh) }));
	assert.equal(portals.length, 1, 'open pill portals exactly one dialog');
	assert.equal(portals[0].container, document.body);
	console.log('3 ok  dialog opens on click');
}

// 4. The dialog places itself above the trigger through the shipped primitives
//    and installs outside-pointer dismissal plus Escape.
{
	dismissals.length = 0;
	portals.length = 0;
	hooks.effect = undefined;
	hooks.state = true;
	const listeners = [];
	globalThis.document.addEventListener = (type, handler) => listeners.push({ type, handler });
	globalThis.document.removeEventListener = () => {};
	html(React.createElement(CostPill, { cost, t: seat(zh) }));

	const anchor = dismissals.filter((entry) => entry.kind === 'anchor').at(-1);
	assert.deepEqual(anchor.options.side, 'top');
	assert.equal(anchor.options.gap, 8);
	assert.equal(anchor.options.margin, 12);
	assert.equal(anchor.options.open, true);
	assert.equal(typeof anchor.options.anchorRef, 'object');
	assert.equal(typeof anchor.options.panelRef, 'object');
	const dismiss = dismissals.filter((entry) => entry.kind === 'dismiss').at(-1);
	assert.equal(dismiss.open, true);
	assert.equal(dismiss.rootRef, anchor.options.anchorRef);
	assert.equal(dismiss.panelRef, anchor.options.panelRef);
	assert.equal(typeof dismiss.setOpen, 'function');

	hooks.effect();
	assert.equal(listeners.length, 1);
	assert.equal(listeners[0].type, 'keydown');
	console.log('4 ok  anchored placement + dismissal');
}

// 5. The panel grid is category + one column per scope. The title bar carries one
//    total per scope column, so there is no separate totals row.
{
	const markup = html(React.createElement(CostDialog, { cost, panelRef: { current: null }, pos: ANCHORED, t: seat(zh) }));
	assert.match(markup, /<div class="dcost_panel"[^>]*>/, 'the panel itself is the grid');
	assert.equal(markup.includes('<dl'), false, 'no separate details list');
	assert.match(markup, /<span class="dcost_titleLabel"><span class="dcost_icon" aria-hidden="true">¥<\/span>花费<\/span><span class="dcost_total" data-deepseek-cost="total-session">¥ 0\.4321<\/span><span class="dcost_total" data-deepseek-cost="total-turn">¥ 0\.0123<\/span>/, 'both totals follow the panel name in the title bar');
	assert.equal(markup.includes('合计'), false, 'the 合计 word and its row are gone');
	assert.match(markup, /<span class="dcost_head" aria-hidden="true"><\/span><span class="dcost_head">会话<\/span><span class="dcost_head">本轮<\/span>/);
	assert.match(markup, /<span class="dcost_term">输入未缓存<\/span><span class="dcost_value" data-deepseek-cost="uncachedInput-session">¥ 0\.0120<\/span><span class="dcost_value" data-deepseek-cost="uncachedInput-turn">¥ 0\.0010<\/span>/);
	assert.match(markup, /<span class="dcost_term">输入缓存<\/span><span class="dcost_value" data-deepseek-cost="cachedInput-session">¥ 0\.0988<\/span><span class="dcost_value" data-deepseek-cost="cachedInput-turn">¥ 0\.0028<\/span>/);
	assert.match(markup, /<span class="dcost_term">输出<\/span><span class="dcost_value" data-deepseek-cost="output-session">¥ 0\.3213<\/span><span class="dcost_value" data-deepseek-cost="output-turn">¥ 0\.0085<\/span>/);
	assert.equal((markup.match(/dcost_head/g) ?? []).length, 3, 'one empty corner plus the two scope captions');
	assert.equal((markup.match(/dcost_term/g) ?? []).length, 3, 'exactly the three cost categories');

	// Order: title totals, the rule, the scope captions, then the breakdown.
	const at = (needle) => markup.indexOf(needle);
	assert.ok(at('data-deepseek-cost="total-session"') < at('dcost_titleRule'), 'totals sit in the title bar');
	assert.ok(at('dcost_titleRule') < at('class="dcost_head">会话'), 'the rule closes the title bar');
	assert.ok(at('class="dcost_head">会话') < at('>输入未缓存<'), 'captions precede the breakdown');
	assert.ok(at('>输出<') < at('dcost_foot'), 'the breakdown closes before the footer');

	// `DSH_COST_PRINT=1` dumps the panel markup — handy when retuning the layout.
	if (process.env.DSH_COST_PRINT === '1') {
		console.log(
			'\n' +
				markup
					.replace(/></g, '>\n<')
					.split('\n')
					.map((line) => `      ${line}`)
					.join('\n') +
				'\n'
		);
	}
	console.log('5 ok  totals in the title bar');
}

// 5b. Items outside the two scopes own their whole line below the grid.
{
	const markup = html(React.createElement(CostDialog, { cost, panelRef: { current: null }, pos: ANCHORED, t: seat(zh) }));
	const foot = /<div class="dcost_foot">([\s\S]*)<\/div>$/.exec(markup);
	assert.notEqual(foot, null, 'the scoped grid is closed before the footer');
	assert.match(foot[1], /<span class="dcost_footTerm">计费时段<\/span><span class="dcost_footValue" data-deepseek-cost="window">空闲时段<\/span>/);
	assert.equal(foot[1].includes('输入未缓存'), false, 'no scoped category leaks into the footer');
	console.log('5b ok unscoped items span the footer');
}

// 5c. Each total is printed exactly once, in the title bar.
{
	const markup = html(React.createElement(CostDialog, { cost, panelRef: { current: null }, pos: ANCHORED, t: seat(zh) }));
	assert.equal((markup.match(/¥ 0\.4321/g) ?? []).length, 1, 'the session total appears exactly once');
	assert.equal((markup.match(/¥ 0\.0123/g) ?? []).length, 1, 'the turn total appears exactly once');
	assert.match(markup, /style="position:fixed;left:10;top:20"/, 'the clamped placement is applied');
	console.log('5c ok totals printed once');
}

// 6. The unplaced measure pass is used until the clamp resolves.
{
	const markup = html(React.createElement(CostDialog, { cost, panelRef: { current: null }, pos: null, t: seat(zh) }));
	assert.match(markup, /style="visibility:hidden;left:0;top:0"/);
	console.log('6 ok  measure pass before placement');
}

// 7. Free (non-DeepSeek) calls add the estimate row and their own footer line.
//    The estimate reuses the two scope columns, dimmed and tilde-marked.
{
	const withFree = { ...cost, freeCalls: 9 };
	const markup = html(React.createElement(CostDialog, { cost: withFree, panelRef: { current: null }, pos: null, t: seat(zh) }));
	assert.equal((markup.match(/dcost_term/g) ?? []).length, 4, 'three categories plus the estimate term');
	assert.match(markup, /<div class="dcost_rule" aria-hidden="true"><\/div>/, 'the estimate is ruled off from the billed rows');
	assert.match(
		markup,
		/<span class="dcost_term dcost_est"[^>]*>预估（按官方价）<\/span><span class="dcost_value dcost_est" data-deepseek-cost="estCost-session"[^>]*>~¥ 0\.1650<\/span><span class="dcost_value dcost_est" data-deepseek-cost="estCost-turn"[^>]*>~¥ 0\.0165<\/span>/
	);
	assert.match(markup, /title="把这些非官方调用按 DeepSeek 官方价折算[^"]*"/, 'the row explains the assumption');
	assert.match(markup, /<span class="dcost_footTerm">未计费调用<\/span><span class="dcost_footValue dcost_note" data-deepseek-cost="free">9 次 · 非 DeepSeek 官方，按 0 计<\/span>/);
	// Order: the billed breakdown, then the estimate, then the footer.
	const at = (needle) => markup.indexOf(needle);
	assert.ok(at('>输出<') < at('dcost_rule'), 'the estimate follows the billed rows');
	assert.ok(at('estCost-session') < at('dcost_foot'), 'the estimate precedes the footer');
	console.log('7 ok  estimate row + unbilled footer');
}

// 7b. Without any non-official call there is no estimate row at all — the panel
//     is unchanged for an official-only session.
{
	const markup = html(React.createElement(CostDialog, { cost, panelRef: { current: null }, pos: null, t: seat(zh) }));
	assert.equal(markup.includes('dcost_est'), false);
	assert.equal(markup.includes('dcost_rule'), false);
	assert.equal(markup.includes('预估'), false);
	console.log('7b ok no estimate when nothing is unbilled');
}

// 8. A peak-priced latest attempt labels the window as peak.
{
	const peak = html(React.createElement(CostDialog, { cost: { ...cost, peak: true }, panelRef: { current: null }, pos: null, t: seat(zh) }));
	assert.match(peak, /data-deepseek-cost="window">高峰时段</);
	assert.match(html(React.createElement(CostPill, { cost: { ...cost, peak: true }, t: seat(zh) })), /高峰时段/);
	console.log('8 ok  peak window labelled');
}

// 9. The dock occupant renders the pill directly — the dock is a flex row, so the
//    pill is one more inline item and needs no DOM anchor to reach into.
{
	portals.length = 0;
	hooks.state = false;
	const rendered = CostDock({ useProjection: (key) => (key === 'deepseekCost' ? cost : undefined), t: seat(zh) });
	assert.notEqual(rendered, null);
	assert.equal(rendered.type, CostPill, 'the occupant renders the pill itself');
	assert.equal(portals.length, 0, 'no portal is opened while the dialog is closed');
	const markup = html(rendered);
	assert.match(markup, /class="dcost_anchor"/);
	assert.match(markup, /本轮 0\.0123/);
	console.log('9 ok  pill rendered inline by the occupant');
}

// 9b. The shipped-DOM surface stays exactly the two hooks the usage row needs:
//     the dialog's row list and the turn footer that names the turn. The anchor
//     DSH 0.1.6 removed must never come back, and nothing is observed wholesale.
{
	const js = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
	assert.equal(js.includes('data-composer-stats'), false, 'no dependency on the removed anchor');
	// Every selector the bundle ever evaluates: the stylesheet guard, the usage
	// dialog's row list (via USAGE_DETAILS), and the trigger/turn-footer pair the
	// click handler walks. A new one has to be argued for here.
	const selectors = [...js.matchAll(/\.(?:querySelector(?:All)?|closest)\(\s*(?:'([^']*)'|`([^`]*)`|([A-Za-z_$][\w$]*))/g)].map((match) => match[1] ?? match[2] ?? match[3]);
	assert.deepEqual(
		selectors,
		['style[data-plugin-css=', 'USAGE_DETAILS', '[data-deepseek-cost="${TURN_COST_MARK}"]', 'button[aria-haspopup="dialog"]', '[${TURN_TAIL}]'],
		'every selector this bundle evaluates, in order'
	);
	assert.match(js, /const USAGE_DETAILS = 'dl\[data-turn-usage-details\]'/, 'the dialog row list is named once');
	assert.match(js, /const TURN_TAIL = 'data-turn-tail'/, 'the turn number comes from the durable turn footer');
	assert.equal((js.match(/new MutationObserver/g) ?? []).length, 1, 'one observer, created by the usage row');
	// The observer watches the body's children only — the portaled dialog — and
	// never a subtree of shipped markup.
	assert.match(js, /observer\.observe\(document\.body, \{ childList: true \}\)/);
	console.log('9b ok shipped-DOM surface is two hooks');
}

// 10. An absent projection renders nothing at all.
{
	portals.length = 0;
	assert.equal(CostDock({ useProjection: () => undefined, t: seat(zh) }), null, 'absent projection');
	assert.equal(CostDock({ useProjection: (key) => (key === 'deepseekCost' ? null : undefined), t: seat(zh) }), null, 'null projection');
	assert.equal(CostDock({ t: seat(zh) }), null, 'no projection seat at all');
	assert.equal(portals.length, 0);
	console.log('10 ok absent projection renders nothing');
}

// 11. The dock occupies `conversation.composer.dock` and owns its locale
//     namespace, without stealing the built-in `stats` cell.
{
	let slot;
	let locale;
	const ctx = {
		effect: (factory) => factory(),
		locale: {
			register: (ns, dicts) => {
				locale = { ns, dicts };
				return () => {};
			}
		},
		slots: {
			inject: (key, callback) => callback(),
			register: (options, component) => {
				slot = { options, component };
				return () => {};
			}
		}
	};
	client.apply(ctx);
	assert.equal(locale.ns, 'deepseek-cost');
	assert.deepEqual(Object.keys(locale.dicts).sort(), ['en', 'zh']);
	assert.equal(slot.options.name, 'conversation.composer.dock');
	assert.equal(slot.options.id, 'deepseek-cost', 'must not shadow the built-in "stats" occupant');
	assert.notEqual(slot.options.id, 'stats');
	assert.equal(slot.options.locale, 'deepseek-cost');
	assert.equal(slot.component, CostDock);
	console.log('11 ok slot registration            ', `${slot.options.name}#${slot.options.id} order=${slot.options.order}`);
}

// 12. The occupant's one effect is the turn-usage watcher, and it hands back its
//     own teardown — rendering the pill costs no other effect.
{
	hooks.effectFns = [];
	hooks.effects = 0;
	const registrations = [];
	globalThis.MutationObserver = class {
		observe() {
			registrations.push('observe');
		}
		disconnect() {
			registrations.push('disconnect');
		}
	};
	globalThis.document.addEventListener = () => registrations.push('listen');
	globalThis.document.removeEventListener = () => registrations.push('unlisten');

	hooks.state = false;
	html(CostDock({ useProjection: (key) => (key === 'deepseekCost' ? cost : undefined), t: seat(zh) }));
	assert.equal(hooks.effectFns.length, 2, 'the watcher, plus the closed dialog\'s Escape listener');
	const cleanups = hooks.effectFns.map((effect) => effect());
	assert.equal(registrations.filter((entry) => entry === 'observe').length, 1, 'exactly one watch is installed');
	assert.equal(typeof cleanups[0], 'function', 'the watcher can be torn down');
	cleanups[0]();
	assert.equal(registrations.at(-1), 'disconnect', 'and the teardown disconnects it');
	console.log('12 ok occupant installs one watcher');
}

// 13. Both dictionaries define exactly the same keys.
{
	assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
	console.log('13 ok dictionaries agree (' + String(Object.keys(zh).length) + ' keys)');
}

// 14. The row appended to the built-in turn-usage dialog: the term, the turn's
//     own billed cost, and — only when that turn was also estimated — the
//     what-if beside it, dimmed and tilde-marked.
{
	const model = turnCostModel(cost, 3, seat(zh));
	assert.deepEqual(Object.keys(model).sort(), ['estimate', 'note', 'term', 'value']);
	assert.equal(model.term, '花费');
	assert.equal(model.value, '¥ 0.0123');
	assert.equal(model.estimate, '（预估 ~¥ 0.0165）');
	assert.match(model.note, /按 DeepSeek 官方价折算/, 'the estimate explains its assumption');

	// An official-only turn carries no estimate at all.
	const plain = turnCostModel(cost, 2, seat(zh));
	assert.equal(plain.value, '¥ 0.5000');
	assert.equal(plain.estimate, undefined);
	assert.equal(plain.note, undefined);

	// The English seat is honoured, and anything the ledger never priced is skipped.
	assert.equal(turnCostModel(cost, 3, seat(en)).term, 'Cost');
	assert.equal(turnCostModel(cost, '3', seat(zh)).value, '¥ 0.0123', 'the footer marker arrives as a string');
	assert.equal(turnCostModel(cost, 99, seat(zh)), undefined, 'a turn with no ledger entry');
	assert.equal(turnCostModel(undefined, 3, seat(zh)), undefined, 'no projection');
	assert.equal(turnCostModel({ ...cost, turns: undefined }, 3, seat(zh)), undefined, 'no ledger');

	const { panel, details } = usageDialog();
	assert.equal(paintUsageRow(panel, model), true);
	assert.equal(
		domHtml(details),
		'<dl><dt class="dcost_usageTerm">花费</dt><dd class="dcost_usageValue" data-deepseek-cost="usage-turn">¥ 0.0123<span class="dcost_usageEst">（预估 ~¥ 0.0165）</span></dd></dl>'
	);
	assert.equal(paintUsageRow(panel, model), true, 'a second paint is a no-op');
	assert.equal(details.children.length, 2, 'the row is never stacked');
	assert.equal(paintUsageRow({ nodeType: 1, querySelector: () => null }, model), false, 'a dialog that is not the usage panel is left alone');
	console.log('14 ok usage-dialog row              ', model.value, model.estimate);
}

// 15. The watcher names the turn from the clicked trigger's footer, catches the
//     portaled dialog as a body child, and answers it with that turn's cost.
{
	const listeners = [];
	const removed = [];
	const observers = [];
	globalThis.MutationObserver = class {
		constructor(callback) {
			this.callback = callback;
			observers.push(this);
		}
		observe(target, options) {
			this.target = target;
			this.options = options;
		}
		disconnect() {
			this.disconnected = true;
		}
	};
	globalThis.document.addEventListener = (type, handler, capture) => listeners.push({ type, handler, capture });
	globalThis.document.removeEventListener = (type, handler, capture) => removed.push({ type, handler, capture });

	hooks.effectFns = [];
	useTurnUsageRow(cost, seat(zh));
	assert.equal(hooks.effectFns.length, 1, 'one watcher, installed once');
	const cleanup = hooks.effectFns[0]();
	assert.equal(typeof cleanup, 'function', 'the watcher tears itself down');
	assert.equal(listeners.length, 1);
	assert.equal(listeners[0].type, 'click');
	assert.equal(listeners[0].capture, true, 'the trigger click is seen before React opens the dialog');
	assert.equal(observers.length, 1);
	assert.equal(observers[0].target, document.body, 'the dialog is portaled to the body');
	assert.deepEqual(observers[0].options, { childList: true });

	// A click on a turn's usage trigger names that turn; clicks that reach no turn
	// footer — inside the open dialog, say — leave the name alone.
	listeners[0].handler({ target: clickedTrigger('2') });
	listeners[0].handler({ target: { closest: () => null } });
	listeners[0].handler({ target: null });
	listeners[0].handler({});

	const second = usageDialog();
	observers[0].callback([{ addedNodes: [second.panel] }]);
	assert.match(domHtml(second.details), /¥ 0.5000/, 'the clicked turn\'s own cost, not the current turn\'s');

	// The next dialog is answered by the turn clicked for it.
	const third = usageDialog();
	listeners[0].handler({ target: clickedTrigger('3') });
	observers[0].callback([{ addedNodes: [third.panel] }]);
	assert.match(domHtml(third.details), /¥ 0.0123/);

	// Nodes that are not dialogs are ignored, and so is a dialog that is not the
	// usage panel.
	observers[0].callback([{ addedNodes: [{ nodeType: 3 }, { nodeType: 1, getAttribute: () => 'menu' }, usageDialog().panel] }]);
	assert.equal(observers[0].callback([{ addedNodes: [] }]), undefined, 'an empty batch is harmless');

	cleanup();
	assert.deepEqual(
		removed.map((entry) => entry.type),
		['click']
	);
	assert.equal(observers[0].disconnected, true, 'the observer stops with the occupant');
	console.log('15 ok watcher names the turn         ', '¥ 0.5000 / ¥ 0.0123');
}

// 15b. With no trigger click to go on — the dialog cannot be opened any other
//      way, but the fallback must still be sound — the current turn is used.
{
	const observers = [];
	globalThis.MutationObserver = class {
		constructor(callback) {
			this.callback = callback;
			observers.push(this);
		}
		observe() {}
		disconnect() {}
	};
	hooks.effectFns = [];
	useTurnUsageRow(cost, seat(zh));
	hooks.effectFns[0]();
	const { panel, details } = usageDialog();
	observers.at(-1).callback([{ addedNodes: [panel] }]);
	assert.match(domHtml(details), /¥ 0.0123/, 'the current turn is turn 3 in the fixture');
	assert.equal(cost.turn, 3, 'the fallback reads the projection\'s current turn');
	console.log('15b ok fallback to the current turn');
}

console.log('\nall checks passed');
