/**
 * Browser half of `dsh-deepseek-cost`.
 *
 * Reads the host's `deepseekCost` session projection and renders one cost pill as
 * an occupant of the `conversation.composer.dock` slot. The pill carries the
 * session total and the current turn at a glance, and opens its own details
 * dialog — the same anchored, dismissible panel shape the built-in step/time and
 * token pills use, reusing the shipped `useAnchoredPosition` /
 * `useDismissOnOutsidePointer` primitives so placement and dismissal behave
 * identically.
 *
 * The dock lays its occupants out inline, so the pill simply sits beside the
 * built-in pills. The one shipped-DOM contract this half does take on is the
 * built-in turn-usage dialog: it offers no slot, so the cost of the turn it
 * describes is appended to the very list it renders its own rows into, and only
 * while that dialog is open. If the projection is absent the occupant renders
 * null and nothing regresses.
 */
window.__ModuleLoader__.load({
	id: 'dsh-deepseek-cost',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const { createPortal } = require('react-dom');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		//#region styles
		// The panel carries the built-in stat dialog's material token for token
		// (`.Xt1eiG_panel` in `dsh-client-ui-chat`): the menu surface token
		// `--dsw-specific-menu` is translucent — `#303136f0` in the desktop dark
		// theme — so the shared `--dsw-menu-backdrop-filter` is what makes a panel
		// read as solid instead of see-through, and the radius is the theme's large
		// step. Both are inherited from `body`, which reaches a portaled panel.
		const css =
			'.dcost_anchor{min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}' +
			'.dcost_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:24px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}' +
			'button.dcost_pill{cursor:pointer}' +
			'button.dcost_pill:hover,button.dcost_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}' +
			'.dcost_icon{flex:none;width:14px;height:14px;font-size:12px;font-weight:600;line-height:1;place-items:center;display:grid}' +
			'.dcost_label{text-overflow:ellipsis;min-width:0;overflow:hidden}' +
			'.dcost_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}' +
			'.dcost_panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed;grid-template-columns:minmax(72px,auto) minmax(0,1fr) minmax(0,1fr);gap:6px 14px;display:grid}' +
			'.dcost_panel>*{min-width:0}' +
			'.dcost_titleLabel{color:var(--dsw-alias-label-primary);font-weight:500;align-items:center;gap:6px;display:inline-flex}' +
			'.dcost_total{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;text-align:right}' +
			'.dcost_titleRule{grid-column:1 / -1;border-top:.5px solid var(--dsw-alias-border-l2);margin:2px 0 4px}' +
			'.dcost_head{color:var(--dsw-alias-label-tertiary);font-weight:500;font-variant-numeric:tabular-nums;text-align:right}' +
			'.dcost_term{color:var(--dsw-alias-label-tertiary)}' +
			'.dcost_value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}' +
			'.dcost_est{color:var(--dsw-alias-label-tertiary)}' +
			'.dcost_rule{grid-column:1 / -1;border-top:.5px solid var(--dsw-alias-border-l2);margin:2px 0}' +
			'.dcost_foot{grid-column:1 / -1;border-top:.5px solid var(--dsw-alias-border-l2);margin-top:4px;padding-top:6px;flex-direction:column;gap:6px;display:flex}' +
			'.dcost_footRow{justify-content:space-between;gap:14px;display:flex}' +
			'.dcost_footTerm{color:var(--dsw-alias-label-tertiary)}' +
			'.dcost_footValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}' +
			'.dcost_note{overflow-wrap:anywhere;text-align:right}' +
			// The row appended to the built-in turn-usage dialog: the dialog's own
			// `dt`/`dd` rules already colour and align it, so these only keep the
			// figure on one line and dim the estimate that rides beside it.
			'.dcost_usageValue{white-space:nowrap}' +
			'.dcost_usageEst{color:var(--dsw-alias-label-tertiary)}';
		const CSS_ID = 'dsh-deepseek-cost/cost.css';
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = 'dsh-deepseek-cost';
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locale
		/** Locale namespace this plugin owns. */
		const NS = 'deepseek-cost';
		const zh = {
			'cost.pill.turnLabel': '本轮',
			'cost.pill.aria': '会话花费 {cost}，本轮花费 {turn}',
			'cost.pill.title': 'DeepSeek 官方价格 · 会话 {cost} · 本轮 {turn}（{window}）',
			'cost.dialog.title': '花费',
			'cost.dialog.aria': '花费明细',
			'cost.col.session': '会话',
			'cost.col.turn': '本轮',
			'cost.row.uncachedInput': '输入未缓存',
			'cost.row.cachedInput': '输入缓存',
			'cost.row.output': '输出',
			'cost.row.window': '计费时段',
			'cost.row.unbilled': '未计费调用',
			'cost.row.free': '{count} 次 · 非 DeepSeek 官方，按 0 计',
			'cost.row.estimate': '预估（按官方价）',
			'cost.row.turnCost': '花费',
			'cost.row.turnCostEst': '（预估 {cost}）',
			'cost.estimate.title': '把这些非官方调用按 DeepSeek 官方价折算；该路由未报告缓存读取时按 95% 缓存命中估算，报告了就按实际命中率',
			'cost.pill.estimate': '预估 {cost}',
			'cost.window.peak': '高峰时段',
			'cost.window.offPeak': '空闲时段'
		};
		const en = {
			'cost.pill.turnLabel': 'this turn',
			'cost.pill.aria': 'Session cost {cost}, this turn {turn}',
			'cost.pill.title': 'DeepSeek official pricing · session {cost} · this turn {turn} ({window})',
			'cost.dialog.title': 'Cost',
			'cost.dialog.aria': 'Cost details',
			'cost.col.session': 'Session',
			'cost.col.turn': 'This turn',
			'cost.row.uncachedInput': 'Uncached input',
			'cost.row.cachedInput': 'Cached input',
			'cost.row.output': 'Output',
			'cost.row.window': 'Billing window',
			'cost.row.unbilled': 'Unbilled calls',
			'cost.row.free': '{count} call(s) · non-DeepSeek, counted as 0',
			'cost.row.estimate': 'Estimate (official rates)',
			'cost.row.turnCost': 'Cost',
			'cost.row.turnCostEst': ' (est. {cost})',
			'cost.estimate.title': 'What these non-official calls would have cost at DeepSeek official rates; a route that reports no cache reads is estimated at a 95% cache-hit rate, and a reported rate is used as it stands',
			'cost.pill.estimate': 'est. {cost}',
			'cost.window.peak': 'peak hours',
			'cost.window.offPeak': 'off-peak hours'
		};
		/**
		 * Translate through the slot-supplied seat, falling back to the shipped
		 * Chinese dictionary when no seat reached this occupant.
		 * @param seat - the locale seat handed down as a prop.
		 * @returns a translate function.
		 */
		function translator(seat) {
			if (typeof seat === 'function') return seat;
			return (key, params) => {
				const template = zh[key] ?? key;
				if (params === undefined) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
			};
		}
		//#endregion

		//#region formatting
		/** Currency symbols for the wire's currency codes. */
		const SYMBOLS = { CNY: '¥', USD: '$' };
		/**
		 * The bare decimal text of an amount, without its currency symbol: whole
		 * yuan keeps two decimals, sub-yuan amounts keep four so small turns stay
		 * readable.
		 * @param value - amount in the reported currency.
		 * @returns the display string.
		 */
		function formatAmount(value) {
			const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0;
			return amount !== 0 && Math.abs(amount) < 1 ? amount.toFixed(4) : amount.toFixed(2);
		}
		/**
		 * An amount with its currency symbol, for places that carry no icon. The
		 * symbol is separated from the figure by a space (the ISO 4217 / SI
		 * convention); a currency with no known symbol renders bare.
		 * @param value - amount in the reported currency.
		 * @param currency - currency code.
		 * @returns the display string.
		 */
		function formatMoney(value, currency) {
			const symbol = SYMBOLS[currency] ?? '';
			return symbol === '' ? formatAmount(value) : `${symbol} ${formatAmount(value)}`;
		}
		/**
		 * An estimated amount. The tilde marks it as a what-if figure that is not
		 * part of the billed total, so it reads as an estimate even when glanced at.
		 * @param value - estimated amount in the reported currency.
		 * @param currency - currency code.
		 * @returns the display string.
		 */
		function formatEstimate(value, currency) {
			return `~${formatMoney(value, currency)}`;
		}
		//#endregion

		//#region dialog seat
		/** Viewport margin the placement clamp keeps (the built-in stat dialogs use the same). */
		const PANEL_MARGIN = 12;
		/** Distance between the trigger's top edge and the panel's bottom. */
		const PANEL_GAP = 8;
		/** Unplaced portal panel: hidden but laid out so the clamp measures real dimensions. */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
		/**
		 * One trigger-anchored dialog seat, mirroring the built-in stat dialogs:
		 * viewport-clamped placement above the trigger, outside-pointer dismissal,
		 * and Escape to close.
		 * @returns open state, refs, and the clamped placement.
		 */
		function useCostDialog() {
			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const pos = primitives.useAnchoredPosition({
				open,
				anchorRef: rootRef,
				panelRef,
				side: 'top',
				gap: PANEL_GAP,
				margin: PANEL_MARGIN
			});
			primitives.useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
			React.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('keydown', onKeyDown);
				return () => document.removeEventListener('keydown', onKeyDown);
			}, [open]);
			return { open, setOpen, rootRef, panelRef, pos };
		}
		//#endregion

		//#region turn-usage row
		/**
		 * The list the built-in turn-usage dialog renders its own rows into. That
		 * dialog exposes no slot, so this attribute — and the turn marker below —
		 * are the entire shipped-DOM surface this plugin reads.
		 */
		const USAGE_DETAILS = 'dl[data-turn-usage-details]';
		/** Durable turn number DSH stamps on a completed turn's footer. */
		const TURN_TAIL = 'data-turn-tail';
		/** Marks the row this plugin owns, so it is never appended twice. */
		const TURN_COST_MARK = 'usage-turn';

		/**
		 * The row to append to one turn's usage dialog.
		 * @param cost - the projection value.
		 * @param turn - turn number the dialog belongs to.
		 * @param t - translate function.
		 * @returns the term/value pair, or undefined when that turn has no ledger entry.
		 */
		function turnCostModel(cost, turn, t) {
			if (cost === undefined || cost === null || turn === undefined || turn === null) return undefined;
			const ledger = cost.turns;
			if (typeof ledger !== 'object' || ledger === null) return undefined;
			const entry = ledger[String(turn)];
			if (entry === undefined || entry === null) return undefined;
			const estimated = typeof entry.estCost === 'number' && entry.estCost > 0;
			return {
				term: t('cost.row.turnCost'),
				value: formatMoney(entry.cost, cost.currency),
				estimate: estimated ? t('cost.row.turnCostEst', { cost: formatEstimate(entry.estCost, cost.currency) }) : undefined,
				note: estimated ? t('cost.estimate.title') : undefined
			};
		}

		/**
		 * Append the row to one open dialog. A dialog already carrying it is left
		 * alone, so a re-render can never stack a second copy.
		 * @param panel - the dialog element.
		 * @param model - the row to append.
		 * @returns whether the dialog carries the row.
		 */
		function paintUsageRow(panel, model) {
			const details = typeof panel.querySelector === 'function' ? panel.querySelector(USAGE_DETAILS) : null;
			if (details === null || details === undefined) return false;
			if (typeof details.querySelector === 'function' && details.querySelector(`[data-deepseek-cost="${TURN_COST_MARK}"]`) !== null) return true;
			const doc = panel.ownerDocument ?? document;
			const term = doc.createElement('dt');
			term.className = 'dcost_usageTerm';
			term.textContent = model.term;
			const value = doc.createElement('dd');
			value.className = 'dcost_usageValue';
			value.setAttribute('data-deepseek-cost', TURN_COST_MARK);
			value.textContent = model.value;
			if (model.estimate !== undefined) {
				const estimate = doc.createElement('span');
				estimate.className = 'dcost_usageEst';
				estimate.textContent = model.estimate;
				value.appendChild(estimate);
			}
			if (model.note !== undefined) value.title = model.note;
			details.appendChild(term);
			details.appendChild(value);
			return true;
		}

		/**
		 * Keep the built-in turn-usage dialog carrying the cost of the turn it
		 * describes.
		 *
		 * That dialog is portaled to `document.body` and rebuilt on every open, so
		 * one observer on the body's child list catches each one. Which turn it
		 * belongs to comes from the clicked trigger's `data-turn-tail` ancestor:
		 * a click on the trigger is the only way the dialog opens, and that marker
		 * is the turn number the projection ledgers its costs under — so a dialog
		 * opened for an older turn shows that turn's cost, never the current one's.
		 * @param cost - the projection value.
		 * @param t - translate function.
		 */
		function useTurnUsageRow(cost, t) {
			const latest = React.useRef({ cost, t });
			latest.current = { cost, t };
			React.useEffect(() => {
				if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return undefined;
				/** Turn whose dialog the most recent trigger click opens. */
				let clicked;
				const onClick = (event) => {
					const target = event.target;
					if (target === null || target === undefined || typeof target.closest !== 'function') return;
					const trigger = target.closest('button[aria-haspopup="dialog"]');
					const tail = trigger === null ? null : trigger.closest(`[${TURN_TAIL}]`);
					if (tail === null) return;
					clicked = tail.getAttribute(TURN_TAIL);
				};
				const observer = new MutationObserver((records) => {
					for (const record of records) {
						for (const node of record.addedNodes) {
							if (node === null || node === undefined || node.nodeType !== 1 || node.getAttribute('role') !== 'dialog') continue;
							// The trigger's turn when one was clicked, else the current turn.
							const model = turnCostModel(latest.current.cost, clicked ?? latest.current.cost?.turn, latest.current.t);
							if (model !== undefined) paintUsageRow(node, model);
						}
					}
				});
				document.addEventListener('click', onClick, true);
				observer.observe(document.body, { childList: true });
				return () => {
					document.removeEventListener('click', onClick, true);
					observer.disconnect();
				};
			}, []);
		}
		//#endregion

		//#region components
		/**
		 * The cost pill and its details dialog.
		 * @param props - the projection value and the locale seat.
		 * @returns the trigger and, while open, its portaled dialog.
		 */
		function CostPill({ cost, t }) {
			const { open, setOpen, rootRef, panelRef, pos } = useCostDialog();
			const symbol = SYMBOLS[cost.currency] ?? '';
			const windowLabel = t(cost.peak ? 'cost.window.peak' : 'cost.window.offPeak');
			const aria = t('cost.pill.aria', { cost: formatMoney(cost.cost, cost.currency), turn: formatMoney(cost.turnCost, cost.currency) });
			const title =
				t('cost.pill.title', { cost: formatMoney(cost.cost, cost.currency), turn: formatMoney(cost.turnCost, cost.currency), window: windowLabel }) +
				(cost.freeCalls > 0 ? ` · ${t('cost.pill.estimate', { cost: formatEstimate(cost.estCost, cost.currency) })}` : '');
			return React.createElement(
				'span',
				{ ref: rootRef, className: 'dcost_anchor' },
				React.createElement(
					'button',
					{
						type: 'button',
						className: 'dcost_pill',
						'aria-haspopup': 'dialog',
						'aria-expanded': open,
						'aria-label': aria,
						title,
						onClick: () => setOpen(!open)
					},
					// The leading currency mark carries the unit for the whole pill, so
					// the amounts beside it stay bare — one currency symbol per pill.
					React.createElement('span', { className: 'dcost_icon', 'aria-hidden': true }, symbol),
					React.createElement(
						'span',
						{ className: 'dcost_label' },
						formatAmount(cost.cost),
						React.createElement('span', { className: 'dcost_sep', 'aria-hidden': true }, '·'),
						`${t('cost.pill.turnLabel')} ${formatAmount(cost.turnCost)}`
					)
				),
				open &&
					createPortal(
						React.createElement(CostDialog, { cost, panelRef, pos, t }),
						document.body
					)
			);
		}

		/**
		 * The cost details dialog.
		 *
		 * The panel itself is the grid — the cost category, then one column per
		 * scope (会话 / 本轮) — so the two scope totals in the title bar sit exactly
		 * over the columns they summarize. The scope captions name those columns
		 * for the breakdown beneath them, and the footer holds the items that
		 * belong to neither scope, each owning its whole line.
		 * @param props - the projection value, panel ref, clamped placement, and locale seat.
		 * @returns the portaled panel.
		 */
		function CostDialog({ cost, panelRef, pos, t }) {
			const money = (value) => formatMoney(value, cost.currency);
			/** One text cell; a cell with no text is decorative (the grid's corner). */
			const cell = (key, className, text) =>
				React.createElement('span', { key, className, ...(text === undefined ? { 'aria-hidden': true } : {}) }, text);
			const amount = (key, className, value) => React.createElement('span', { key, className, 'data-deepseek-cost': key }, money(value));
			// [locale key, session amount, current-turn amount]
			const categories = [
				['uncachedInput', cost.uncachedCost, cost.turnUncachedCost],
				['cachedInput', cost.cacheReadCost, cost.turnCacheReadCost],
				['output', cost.outputCost, cost.turnOutputCost]
			];

			const children = [
				// Title bar: the panel name, then one total per scope column.
				React.createElement(
					'span',
					{ key: 'title', className: 'dcost_titleLabel' },
					React.createElement('span', { className: 'dcost_icon', 'aria-hidden': true }, SYMBOLS[cost.currency] ?? ''),
					t('cost.dialog.title')
				),
				amount('total-session', 'dcost_total', cost.cost),
				amount('total-turn', 'dcost_total', cost.turnCost),
				React.createElement('div', { key: 'title-rule', className: 'dcost_titleRule', 'aria-hidden': true }),
				// The scope captions for everything below.
				cell('corner', 'dcost_head'),
				cell('col-session', 'dcost_head', t('cost.col.session')),
				cell('col-turn', 'dcost_head', t('cost.col.turn'))
			];
			for (const [key, session, turn] of categories) {
				children.push(cell(`${key}-term`, 'dcost_term', t(`cost.row.${key}`)));
				children.push(amount(`${key}-session`, 'dcost_value', session));
				children.push(amount(`${key}-turn`, 'dcost_value', turn));
			}
			// The what-if for routes that were billed 0: same two scopes, dimmed and
			// tilde-marked so it is never mistaken for part of the billed total.
			if (cost.freeCalls > 0) {
				const note = t('cost.estimate.title');
				children.push(React.createElement('div', { key: 'est-rule', className: 'dcost_rule', 'aria-hidden': true }));
				children.push(React.createElement('span', { key: 'est-term', className: 'dcost_term dcost_est', title: note }, t('cost.row.estimate')));
				children.push(
					React.createElement('span', { key: 'est-session', className: 'dcost_value dcost_est', 'data-deepseek-cost': 'estCost-session', title: note }, formatEstimate(cost.estCost, cost.currency))
				);
				children.push(
					React.createElement('span', { key: 'est-turn', className: 'dcost_value dcost_est', 'data-deepseek-cost': 'estCost-turn', title: note }, formatEstimate(cost.turnEstCost, cost.currency))
				);
			}

			const footer = [
				React.createElement(
					'div',
					{ key: 'window', className: 'dcost_footRow' },
					React.createElement('span', { className: 'dcost_footTerm' }, t('cost.row.window')),
					React.createElement('span', { className: 'dcost_footValue', 'data-deepseek-cost': 'window' }, t(cost.peak ? 'cost.window.peak' : 'cost.window.offPeak'))
				)
			];
			if (cost.freeCalls > 0) {
				footer.push(
					React.createElement(
						'div',
						{ key: 'free', className: 'dcost_footRow' },
						React.createElement('span', { className: 'dcost_footTerm' }, t('cost.row.unbilled')),
						React.createElement('span', { className: 'dcost_footValue dcost_note', 'data-deepseek-cost': 'free' }, t('cost.row.free', { count: cost.freeCalls }))
					)
				);
			}
			children.push(React.createElement('div', { key: 'foot', className: 'dcost_foot' }, footer));

			return React.createElement(
				'div',
				{
					ref: panelRef,
					className: 'dcost_panel',
					role: 'dialog',
					'aria-label': t('cost.dialog.aria'),
					style: pos ?? MEASURE_STYLE
				},
				children
			);
		}

		/**
		 * The composer-dock occupant: reads the projection, keeps the built-in
		 * turn-usage dialog carrying the cost of the turn it describes, and renders
		 * the cost pill as a direct child of the dock.
		 *
		 * The dock is a flex row that already lays every occupant out inline
		 * (`InputBar.module.css` `.dock` — `display:flex; justify-content:center;
		 * gap:12px`), so the pill simply becomes one more item beside the built-in
		 * step/time and token pills. Rendering it here rather than reaching into the
		 * statistics row keeps this on the public slot contract; DSH 0.1.6 dropped
		 * that row's DOM hook, which is what an inline portal would have needed.
		 * @param props - standard Session slot props.
		 * @returns the pill, or null while the projection is absent.
		 */
		function CostDock({ useProjection, t }) {
			const cost = typeof useProjection === 'function' ? useProjection('deepseekCost') : undefined;
			const translate = translator(t);
			useTurnUsageRow(cost, translate);
			if (cost === undefined || cost === null) return null;
			return React.createElement(CostPill, { cost, t: translate });
		}
		//#endregion

		//#region plugin
		/** Required services: the UI slot registry and the client locale registry. */
		const inject = ['slots', 'locale'];
		/**
		 * Mount the cost pill.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-cost: dictionaries');
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'deepseek-cost',
						order: 20,
						locale: NS
					},
					CostDock
				)
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		/** Test seat: the pieces `test/client.test.mjs` renders in isolation. Not an API. */
		exports.__internals = {
			CostDialog,
			CostDock,
			CostPill,
			formatAmount,
			formatEstimate,
			formatMoney,
			paintUsageRow,
			turnCostModel,
			useTurnUsageRow,
			NS,
			USAGE_DETAILS,
			TURN_TAIL,
			en,
			zh
		};
		return module.exports;
	}
});
