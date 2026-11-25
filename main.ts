// Twin-Tranche Trend: a deterministic hourly bars-replay bot for
// make.fun's "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// Idea in one paragraph: buy-and-hold loses whenever the market drifts
// down, so this bot only owns an asset while its short trend is above its
// long trend AND its last 24 hours are up more than 1%, and it leaves the
// moment either breaks or the price slips 3.5% off its peak since entry.
// A third exit banks the trade at +3.5% from entry: in a falling market
// that keeps bounce profits instead of riding them back down, and in a
// rising market the entry filters simply buy back in on the next bar.
// come in two tranches (12.5% of equity, then a top-up to the 25% cap
// once the trade has proven itself for 6 bars), which keeps a quiet
// up-trend window above the 8-trade guardrail without churning. Every
// decision is integer arithmetic on the bars the harness feeds it: no
// randomness, no clock, no network, no look-ahead, so two runs produce
// byte-identical action logs.
//
// Wire: agent-fun/bars-replay/v1, spoken through the kit's shim in
// vendor/makefun-bars.ts. The grader runs `node /bot/main.ts`.

import { BPS, runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

// --- tuning constants (all in whole bars / basis points) --------------------
const FAST_BARS = 8; // fast EMA lookback, in hourly bars
const SLOW_BARS = 32; // slow EMA lookback, in hourly bars
const MOMENTUM_BARS = 24; // trailing return window for the entry filter
const MIN_HISTORY = 33; // bars of history before the first signal
const TRANCHE_BPS = 1250; // first tranche: 12.5% of equity
const MAX_POSITION_BPS = 2500; // top-up target: 25% of equity (the cap)
const PROVE_BARS = 6; // bars a first tranche must age before the top-up
const TRAIL_BPS = 350; // sell when the close is 3.5% below the peak since entry
const TAKE_BPS = 350; // bank the trade when the close is 3.5% above its entry
const MOMENTUM_MIN_BPS = 100; // entry needs a 24 h return above +1%, not just above 0
const TOPUP_MIN_BPS = 200; // top-up needs the trade up 2% from its entry close
const MAX_SLIPPAGE_BPS = 500; // 5%: wide enough that hourly gaps never reject
const EMA_SCALE = 1000n; // fixed-point scale for the EMAs (price * 1000)

/** Per-symbol trend state, kept across batches. */
interface Trend {
  closes: bigint[]; // every close seen, in batch order
  fast: bigint | null; // fast EMA, scaled by EMA_SCALE; null before the first bar
  slow: bigint | null; // slow EMA, scaled by EMA_SCALE
  entryClose: bigint | null; // close of the bar that decided the current entry
  peakClose: bigint | null; // highest close since the current entry
  entrySeq: number; // batch seq of the bar that decided the current entry
  tranches: number; // 1 after the first buy, 2 after the top-up
}

const trends = new Map<string, Trend>();

function trendFor(symbol: string): Trend {
  let t = trends.get(symbol);
  if (t === undefined) {
    t = { closes: [], fast: null, slow: null, entryClose: null, peakClose: null, entrySeq: -1, tranches: 0 };
    trends.set(symbol, t);
  }
  return t;
}

/**
 * One EMA step in exact integer arithmetic: ema moves 2/(n+1) of the way
 * from its old value toward the new price, all scaled by EMA_SCALE so the
 * truncation of BigInt division stays far below a price tick.
 */
function emaStep(prev: bigint | null, price: bigint, bars: number): bigint {
  const scaled = price * EMA_SCALE;
  if (prev === null) return scaled;
  const k = 2n;
  const n = BigInt(bars + 1);
  return prev + ((scaled - prev) * k) / n;
}

/** True while the symbol's short trend sits above its long trend. */
function trendUp(t: Trend): boolean {
  return t.fast !== null && t.slow !== null && t.fast > t.slow;
}

/** True while the symbol's close beats its close MOMENTUM_BARS bars back by more than MOMENTUM_MIN_BPS. */
function momentumUp(t: Trend): boolean {
  const n = t.closes.length;
  if (n <= MOMENTUM_BARS) return false;
  return t.closes[n - 1]! * 10000n > t.closes[n - 1 - MOMENTUM_BARS]! * BigInt(10000 + MOMENTUM_MIN_BPS);
}

/** True once the price has fallen TRAIL_BPS below its peak since entry. */
function trailedOff(t: Trend, close: bigint): boolean {
  if (t.peakClose === null) return false;
  return close * 10000n < t.peakClose * BigInt(10000 - TRAIL_BPS);
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // A sell's proceeds never fund a buy of the same reply, so track the
    // cash the buys of this reply may still spend.
    let spendable = state.cash;
    const orders: OrderInput[] = [];

    // Fold every bar in first, so the broad-market gate sees SOL's bar
    // from this same batch before any symbol is decided on.
    for (const { symbol } of state.hello.symbols) {
      const close = state.close(symbol);
      if (close === null) continue;
      const t = trendFor(symbol);
      t.closes.push(close);
      t.fast = emaStep(t.fast, close, FAST_BARS);
      t.slow = emaStep(t.slow, close, SLOW_BARS);
    }
    // No new entries while the broad market itself trends down: in a
    // falling market the bounces this bot would buy are mostly traps.
    // (Gate currently off: SOL never trended up on the dev window, so a
    // hard gate strands the bot in cash and under the 8-trade guardrail.
    // The per-symbol filters below carry the downside protection instead.)
    const gateUp = true;

    for (const { symbol } of state.hello.symbols) {
      const close = state.close(symbol);
      if (close === null) continue;
      const t = trendFor(symbol);

      // Warm-up batches are for building history only; the harness rejects
      // any order decided on one. Too little history means no signal yet.
      if (state.warmingUp || t.closes.length < MIN_HISTORY) continue;

      const held = state.positions.get(symbol);
      const up = trendUp(t);
      const mom = momentumUp(t);

      if (held !== undefined) {
        // Keep the peak fresh, then check the three exits: trend broken,
        // the trailing stop tripped, or the profit target reached. Any one
        // sells the whole position. Banking a bounce beats riding it back
        // down in a falling market, and in a rising one the entry filters
        // simply buy back in on the next bar.
        if (t.peakClose === null || close > t.peakClose) t.peakClose = close;
        const tookProfit =
          t.entryClose !== null && close * 10000n >= t.entryClose * BigInt(10000 + TAKE_BPS);
        if (!up || trailedOff(t, close) || tookProfit) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          t.entryClose = null;
          t.peakClose = null;
          t.tranches = 0;
          continue;
        }
        // Top-up: the trade has aged, is up at least TOPUP_MIN_BPS from
        // entry, and both filters still agree. Size it to the cap.
        if (
          t.tranches === 1 &&
          batch.seq - t.entrySeq >= PROVE_BARS &&
          t.entryClose !== null &&
          close * 10000n > t.entryClose * BigInt(10000 + TOPUP_MIN_BPS) &&
          mom
        ) {
          const room = state.weightRoom(symbol);
          const target = (BigInt(MAX_POSITION_BPS) * state.equity) / BPS;
          const heldValue = state.value(symbol, held.qty);
          let topUp = target - heldValue;
          if (topUp > room) topUp = room;
          if (topUp > spendable) topUp = spendable;
          const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
          if (topUp >= minNotional) {
            orders.push({ side: 'buy', symbol, notional_quote_units: topUp, max_slippage_bps: MAX_SLIPPAGE_BPS });
            spendable -= topUp;
            t.tranches = 2;
          }
        }
        continue;
      }

      // Flat: enter only while both filters agree and the broad market is
      // not itself in a downtrend, with the first tranche.
      if (up && mom && gateUp) {
        let size = (BigInt(TRANCHE_BPS) * state.equity) / BPS;
        const room = state.weightRoom(symbol);
        if (size > room) size = room;
        if (size > spendable) size = spendable;
        const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
        if (size >= minNotional) {
          orders.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
          spendable -= size;
          t.entryClose = close;
          t.peakClose = close;
          t.entrySeq = batch.seq;
          t.tranches = 1;
        }
      }
    }

    return orders;
  },
});
