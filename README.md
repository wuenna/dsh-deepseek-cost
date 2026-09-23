# dsh-deepseek-cost

A DeepSeek Harness (DSH) plugin that shows what the conversation has cost so far:
a cost pill beside the built-in step/time and token statistics, with the session
total and the current turn priced at DeepSeek's official peak/off-peak API rates,
plus one 花费 row in the built-in 本轮用量 panel of every completed turn.
Every non-DeepSeek route is counted as `0`.

## What it adds

One **cost pill** in the composer dock, inline beside the built-in step/time and
token pills. The leading `¥` is the currency mark for the whole pill, so the
amounts beside it stay bare — one symbol per pill:

```
[¥] 0.4321 · 本轮 0.0123
```

Clicking it opens its own details dialog, shaped like the built-in step and token
dialogs (same panel, title, and rule — the same shipped `useAnchoredPosition` /
`useDismissOnOutsidePointer` primitives position and dismiss it).

The panel itself is the grid: the cost category, then **one column per scope**.
The two scope totals sit in the title bar, and because the grid starts at the
panel edge they land exactly over the columns they summarize.

```
¥  花费                  ¥ 0.4321     ¥ 0.0123
──────────────────────────────────────────────
                          会话         本轮
输入未缓存               ¥ 0.0120     ¥ 0.0010
输入缓存                 ¥ 0.0988     ¥ 0.0028
输出                     ¥ 0.3213     ¥ 0.0085
──────────────────────────────────────────────
预估（按官方价）         ~¥ 0.1650    ~¥ 0.0165
──────────────────────────────────────────────
计费时段                              空闲时段
未计费调用            1 次 · 非 DeepSeek 官方，按 0 计
```

- The three cost categories are the prompt-side split (输入未缓存 / 输入缓存) plus
  输出, each priced per scope. The 会话 / 本轮 captions name the two value columns.
- The title bar carries **one total per scope**, so no totals row is repeated
  below and neither total is printed twice.
- **预估（按官方价）** answers "what would the routes billed at 0 have cost at
  official rates?" — see [Estimating the routes billed at 0](#estimating-the-routes-billed-at-0).
  It reuses the two scope columns, is dimmed, and is tilde-marked so it is never
  read as part of the billed total. It appears only when some call was actually
  billed at 0.
- Items that belong to neither scope own a whole line in the full-width footer
  below the grid — that is how "spans both columns" is expressed here, and it
  also keeps the divider above them continuous (a spanning grid row would break
  its hairline on the column gaps).

Nothing built in is replaced. The pill is a normal occupant of the composer's dock
slot, and the dock lays its occupants out inline, so the pill simply sits beside
the built-in pills. If the projection is absent the occupant renders `null` and
nothing regresses.

### The row in the built-in 本轮用量 panel

Opening a completed turn's built-in usage info shows the turn's tokens; this
plugin appends the turn's cost as the last row of that same list, so the money is
read where the tokens are:

```
本轮用量                     22,582.085 tok
──────────────────────────────────────────
提供方 / 模型   deepseek-official/deepseek-flash
缓存命中                            97.8%
未缓存输入                     487,432 tok
缓存读取                    22,070,784 tok
缓存写入                           0 tok
输出                            23,869 tok
花费                              ¥ 1.02
```

That panel is shipped UI with no slot of its own, so this is the one place the
plugin reads another package's DOM — deliberately, and through exactly two hooks:

- `dl[data-turn-usage-details]` — the attribute DSH puts on the turn-usage
  panel's own row list (the neighbouring session-stats and performance panels use
  `data-session-stats-details`, so this one is unambiguous). The row is appended
  only while that panel is open, and only after checking it is not already there.
- `data-turn-tail` — the turn number DSH stamps on a completed turn's footer,
  read from the clicked trigger's ancestors. A trigger click is the only way the
  panel opens, so a panel opened for an older turn shows *that* turn's cost, never
  the current turn's.

The append is idempotent, the observer watches only `document.body`'s children
(where the panel is portaled), and the whole watcher is one effect on the occupant
that disconnects when the occupant unmounts. `client.test.mjs` asserts the
selector inventory of the whole bundle, so a third hook cannot be added quietly.

A turn whose calls were billed at `0` still gets the row, carrying the same
what-if as the dialog — `花费 ¥ 0.00（预估 ~¥ 0.98）` — and a turn older than the
plugin's own ledger was never priced at all, so its panel is left untouched.

## Estimating the routes billed at 0

Only `deepseek-official` is billed, so every other provider shows a real cost of
`0`. The estimate says what those same requests *would* have cost at official
rates.

**Which rate.** The model id picks the reference tier: an id naming a Pro model
references `deepseek-v4-pro`, everything else references `deepseek-flash` — a
Flash alias, a DeepSeek id of unknown version, or a model from another family
entirely (`Qwen`, `GLM`, `MiniCPM5-2B`). Flash is the cheapest official rate and
so the conservative choice for a what-if.

**Which cache-hit rate.** This is the one premise the estimate rests on, so it is
stated rather than buried:

| Route reports | Rate used |
| --- | --- |
| no cache reads at all (0%) | **95%** cache hit |
| any non-zero cache hit rate | that rate, as reported |

Third-party routes frequently report no cache accounting at all, and an agent
session re-sends almost its whole prompt every step. Reading a reported zero
literally would price the entire prompt at the cache-miss rate — an order of
magnitude too high. So the whole prompt is re-split by the hit rate rather than
read bucket by bucket, and 95% is the shape a real session settles into.

The estimate follows the same rules as the real cost: the same peak/off-peak
multiplier, the same in-step sample replacement, and the same retry accounting.

## Pricing

Rates are **CNY per 1,000,000 tokens**, off-peak, with peak windows charged at
exactly twice every rate. Source:
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>.

| Model ids | Effective from (Beijing) | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | ---: | ---: | ---: |
| `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | 2026-08-17 00:00 | 0.05 | 1.5 | 4.5 |
| same | 2026-09-10 12:00 | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | 2026-08-17 00:00 | 0.15 | 4.5 | 13.5 |

- **Peak windows** are Beijing 09:00–12:00 and 14:00–18:00, **Monday through
  Friday**; everything else is off-peak, weekends included.
- The two retired Flash aliases are still callable and are served — and billed —
  as `deepseek-flash`, so they share its tiers.
- **Cache writes** are charged at the cache-miss rate.
- **Reasoning tokens** are already part of the provider's `outputTokens`, so
  they need no separate row.
- A model id with no published rate, and every provider other than
  `deepseek-official` / `deepseek`, is billed `0` while its tokens stay visible
  (`freeCalls` in the projection), so an unpriced call is never silently folded
  into a DeepSeek figure.

## How it works

**Host half** (`lib/index.js`) registers the `deepseekCost` session projection on
`ctx.sessionProjections`. A projection is a pure, synchronous fold over the
whole durable session log, so the figures are complete regardless of transcript
paging and compaction — the same seam `tokenUsage` and `sessionStats` use.

The fold mirrors token-meter's replacement rule: the last usage sample inside one
`(turn, step)` replaces its predecessor, and `llm/retry-started` closes that slot
so a retried attempt adds a second billed attempt. Route attribution prefers the
settled assistant message's own `source`, then the last `request/header` /
`request/context` snapshot.

Besides the session and current-turn totals, the fold keeps a **per-turn ledger**
(`turns`, keyed by the turn number) of every turn's cost and estimate. A finished
turn is never the current turn again — `turn/start` resets the current-turn
figures at every boundary — yet its usage panel stays openable from the
transcript, so the ledger is what makes that panel answerable. Replacement and
retry rewrite only their own turn's entry.

**Browser half** (`lib/client.js`) registers one occupant on the
`conversation.composer.dock` list slot, reads the projection with
`useProjection('deepseekCost')`, and returns the pill as that occupant's element.
The dock is a flex row (`InputBar.module.css` `.dock`), so the pill is laid out
inline beside the built-in pills; the occupant owns no portal and no anchoring.
The pill owns its dialog seat, replicating the built-in `useStatDialog` placement
and dismissal from the shipped primitives. The occupant's one effect is the
turn-usage row watcher described above.

The dock slot is the public contract, which is what makes the pill survive DSH
upgrades: 0.1.6 dropped the statistics row's `data-composer-stats` hook that an
inline portal would have needed. The pill never referenced a class name belonging
to another package. The 本轮用量 row is the deliberate exception — that panel
offers no slot — and it is confined to the two `data-` attributes above rather
than any hashed class name.

The package declares both `dsh.bundle.patch` and `dsh.client`, so one install
command wires the host row and the browser bundle.

## Where things live

Two directories carry this plugin's name, and they hold different things:

| Path | What it is |
| --- | --- |
| `~/.dsh/plugins/dsh-deepseek-cost/` | The **plugin source**: `package.json`, `cordis.patch.yml`, `lib/`, `test/`, `README.md`. Everything you edit lives here. |
| `~/.dsh/dsh-deepseek-cost/` | The plugin's **state dir**, owned by the running plugin. It holds only `boot.log`. |

`boot.log` is a one-line activation record the host half overwrites on every
mount (`2026-09-11T11:43:49.732Z host half mounted: projection "deepseekCost"
registered`). It is the quickest way to answer "did my restart actually load the
plugin?" when the browser shows nothing. Its parent honours `$DSH_HOME` the way
the rest of the harness does, so setting that variable moves it.

The name collision is the harness's own convention — a plugin owns
`~/.dsh/<package-name>/` for state, next to `~/.dsh/dsh-usage/` from the
community usage plugin — while `plugins/` is where this one's source happens to
sit. Nothing writes to the source tree at runtime, and the test suite redirects
`$DSH_HOME` to a temp dir so running it never touches the real state dir.

## Install

The package lives at `~/.dsh/plugins/dsh-deepseek-cost` and is linked into the web
profile's `node_modules`, with one row in the profile's own patch layer.

```powershell
# 1. link the package into the profile (a junction keeps one source of truth)
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-deepseek-cost" "$env:USERPROFILE\.dsh\plugins\dsh-deepseek-cost"
```

Then `~/.dsh/profiles/web/cordis.patch.yml` declares the row:

```yaml
- insert:
    - id: deepseek-cost
      name: 'dsh-deepseek-cost'
```

The web profile is `patchReload: live`, so a running `dsh web` re-applies this
file when it changes; refresh the page and the pill appears. A `dsh web` restart
also picks it up. The host half writes a one-line activation record to
`~/.dsh/dsh-deepseek-cost/boot.log` on every mount, which is how you confirm it.

Declare the row **once**. `insert` appends, so listing `dsh-deepseek-cost` in both
`dsh.profile.bundles` and the profile patch layer mounts it twice.

### The idiomatic alternative

`dsh plugin --profile web add <path>` is the normal install path — it links the
package, appends the name to `dsh.profile.bundles`, and lets the package's own
`dsh.bundle.patch` own the row. It is blocked on this machine by a pnpm store
mismatch:

```
ERR_PNPM_UNEXPECTED_STORE  node_modules is linked from
C:\Users\wuw\AppData\Local\pnpm\store\v11, pnpm now wants
C:\Users\wuw\.dsh\.pnpm-store\v11
```

To switch to it, reconcile the store first (`pnpm config set store-dir
C:\Users\wuw\AppData\Local\pnpm store --global`), run `pnpm install` in
`~/.dsh/profiles/web`, then remove the row above before running
`dsh plugin --profile web add`.

## Tests

```powershell
cd C:\Users\wuw\.dsh\plugins\dsh-deepseek-cost
node test/fold.test.mjs      # 23 pricing/fold cases
node test/client.test.mjs    # 20 browser-half render/wiring cases
node test/wiring.test.mjs    #  5 host-half + package-resolution cases
```

`fold.test.mjs` cases 1 and 2 reproduce two aggregates from a real DeepSeek
console ledger (2026-09-10 off-peak, 2026-09-11 peak) to six decimals under the
tier in force on those days, which pins the tier table, the peak windows, and the
bucket mapping together. Case 2b shows the same token mix one week later priced
under the current tier. `client.test.mjs` drives the bundle through the real
`window.__ModuleLoader__.load` contract and renders the pill and its dialog
against a minimal React stand-in, because React is a browser-side static module
in DSH and is not installed as a Node package. It asserts the single visible
currency mark, the clamped/measure placement, both dismissal paths, the dialog's
rows, the absent-projection no-op, the appended 本轮用量 row (including which turn
it answers for, its idempotence, and its teardown) — and, as a regression guard
for the 0.1.6 breakage, the complete inventory of selectors the bundle evaluates,
so the DOM surface cannot grow unnoticed.

## Configuration

The price book lives at the top of `lib/index.js` (`FLASH_TIERS`, `PRO_TIERS`,
`PRICE_BOOK`, `OFFICIAL_PROVIDERS`). Add a tier for a new model id, or a new
`{ from, ... }` entry when DeepSeek changes rates. `stateVersion` must be bumped
whenever the fold's meaning changes, so persisted projection checkpoints are
discarded instead of forward-applied — it is at `2`, the version that added the
per-turn ledger; a version-1 checkpoint also fails the state schema, so it is
replayed from the session log either way.
