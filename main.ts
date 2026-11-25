// Pump.fun Paper Sprint: two-tier momentum bot for agent-fun/replay/v2.
//
// Strategy, validated offline on this competition's full 24h dev dataset
// (all three dataset parts, kit's own replay model: fills 2 slots after the
// decision, curve fees 95 + 30 bps, tx fee 105,000 lamports, seeded 2% tx
// failures, closes on complete and at the end of data):
//   net +1.30 SOL on 10 SOL capital (+13.0%), max drawdown 2.8%,
//   877 fills, 433 distinct mints (guardrail needs >= 20), 126 winning
//   coins / 317 losing coins. PnL is concentrated: the top 3 coins made
//   +0.355 / +0.241 / +0.241 SOL, so the final 6h window's result depends on
//   whether it holds a mooner — that is the bet this bot makes.
//
//   Tier A (probe): on the first batch where a coin's price is >= 1.5x its
//     create price and its size cap covers the probe, buy 0.011 SOL.
//     TP +20%, SL -15%, max hold 1,500 slots (~10 min).
//   Tier B (press): when a coin reaches >= 8.0x its create price, buy
//     0.60 SOL (or the 1%-of-real-reserve size cap, when smaller but still
//     >= 0.10 SOL). TP +40%, SL -30%, max hold 3,000 slots (~20 min).
//     A coin already probed by Tier A gets topped up to Tier B instead of a
//     second fresh entry, and adopts Tier B exits; a coin whose Tier A probe
//     already exited may still earn a fresh Tier B entry later.
//   Exits are always: take-profit, stop-loss, max hold, or the creator
//     selling while held. Creator sells do NOT block entry (tested: the
//     filter cost +0.43 SOL on the dev window), but they do trigger an exit.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// so its two grading executions produce byte-identical action logs.

import { BPS, runBot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

/** Tier A trigger: price now over create price, bps (15,000 = 1.5x). */
const TIER_A_RUNUP_BPS = 15_000n;
/** Tier A probe size, lamports (0.011 SOL: just above the 0.01 SOL round-trip bar). */
const TIER_A_SIZE = 11_000_000n;
/** Tier A take-profit over cost, bps. */
const TIER_A_TP_BPS = 2_000n;
/** Tier A stop-loss under cost, bps. */
const TIER_A_SL_BPS = 1_500n;
/** Tier A max hold, slots. */
const TIER_A_MAX_HOLD = 1_500;
/** Tier A entry window: oldest age (slots since create) still allowed. */
const TIER_A_MAX_AGE = 5_000;
/** Tier B trigger: price now over create price, bps (80,000 = 8.0x). */
const TIER_B_RUNUP_BPS = 80_000n;
/** Tier B size, lamports (0.60 SOL). */
const TIER_B_SIZE = 600_000_000n;
/** Tier B smallest buy worth sending, lamports (0.10 SOL). */
const TIER_B_MIN_BUY = 100_000_000n;
/** Tier B take-profit over cost, bps. */
const TIER_B_TP_BPS = 4_000n;
/** Tier B stop-loss under cost, bps. */
const TIER_B_SL_BPS = 3_000n;
/** Tier B max hold, slots. */
const TIER_B_MAX_HOLD = 3_000;
/** Tier B entry window: oldest age (slots since create) still allowed. */
const TIER_B_MAX_AGE = 54_000;
/** Slippage allowed on buys and sells, bps (wide open: never refuse a fill). */
const SLIPPAGE_BPS = 10_000;
/** Curve fees: protocol 95 + creator 30 bps. */
const FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devSold: boolean;
  doneA: boolean;
  doneB: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  tier: 'A' | 'B';
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();
/** Client ids of Tier B buys sent (fresh entries and top-ups). */
const tierBBuys = new Set<string>();
let orderNo = 0;

function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
  return false;
}
function hasPendingSell(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
  return false;
}

await runBot({
  onBatch(state, batch) {
    // 1. Read the batch's events into coin records.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devSold: false,
          doneA: false,
          doneB: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        if (!e.is_buy && e.user === c.creator) c.devSold = true;
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.doneA = true;
          c.doneB = true;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
    for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

    // 2. Process fills: track tx paid, open/close held records.
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled') {
        const isB = tierBBuys.delete(f.client_id);
        if (h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            tier: isB ? 'B' : 'A',
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        } else if (isB) {
          h.tier = 'B';
        }
      }
      if (f.side === 'buy' && f.status !== 'filled') tierBBuys.delete(f.client_id);
      if (f.side === 'sell' && f.status === 'filled') {
        selling.delete(f.mint);
        if (!state.positions.has(f.mint)) held.delete(f.mint);
      }
    }
    for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
    }

    // 3. Exits first: take-profit / stop-loss / max hold / creator sold.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, tier: 'A', devSoldAtOpen: c?.devSold ?? false };
        held.set(mint, h);
      }
      let mk = marks.get(mint);
      if (mk === undefined) {
        const cv = state.curves.get(mint);
        if (cv === undefined) continue;
        mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      }
      const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      const tp = h.tier === 'B' ? TIER_B_TP_BPS : TIER_A_TP_BPS;
      const sl = h.tier === 'B' ? TIER_B_SL_BPS : TIER_A_SL_BPS;
      const maxHold = h.tier === 'B' ? TIER_B_MAX_HOLD : TIER_A_MAX_HOLD;
      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + tp)) exit = true;
        if (value * BPS <= basis * (BPS - sl)) exit = true;
      }
      if (state.slot - h.openedSlot >= maxHold) exit = true;
      if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SLIPPAGE_BPS });
      selling.add(mint);
      if (c !== undefined) {
        // A Tier A exit must NOT close the Tier B door: the coin may still
        // 8x later and earn a fresh Tier B entry. Only a Tier B exit ends it.
        c.doneA = true;
        if (h.tier === 'B') c.doneB = true;
      }
    }

    // 4. Tier B: press proven mooners (fresh entry, or top-up of a Tier A probe).
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let slotsUsed = state.committedPositionCount();
    const maxSlots = state.hello.caps.max_open_positions;
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.doneB || c.complete) continue;
      const age = state.slot - c.createSlot;
      if (age > TIER_B_MAX_AGE) {
        c.doneB = true;
        continue;
      }
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (c.vq0 <= 0n || c.vt0 <= 0n || vt <= 0n) continue;
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup < TIER_B_RUNUP_BPS) continue;
      const h = held.get(c.mint);
      const isTopUp = h !== undefined && h.tier === 'A' && state.positions.has(c.mint);
      if (!isTopUp) {
        if (slotsUsed >= maxSlots) continue;
        if (hasPendingBuy(state, c.mint)) continue;
      } else if (selling.has(c.mint) || hasPendingBuy(state, c.mint)) {
        continue;
      }
      const maxBuy = state.maxBuyLamports(c.mint);
      const amount = TIER_B_SIZE < maxBuy ? TIER_B_SIZE : maxBuy;
      if (amount < TIER_B_MIN_BUY) continue;
      if (free < amount + tx) continue;
      const cid = `b${++orderNo}`;
      tierBBuys.add(cid);
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: SLIPPAGE_BPS, client_id: cid });
      free -= amount + tx;
      if (!isTopUp) slotsUsed += 1;
      c.doneB = true;
    }

    // 5. Tier A: probe fresh launches at 1.5x.
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.doneA || c.complete) continue;
      const age = state.slot - c.createSlot;
      if (age > TIER_A_MAX_AGE) {
        c.doneA = true;
        continue;
      }
      if (slotsUsed >= maxSlots) continue;
      if (hasPendingBuy(state, c.mint)) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      if (c.vq0 <= 0n || c.vt0 <= 0n || vt <= 0n) continue;
      const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
      if (runup < TIER_A_RUNUP_BPS) continue;
      const maxBuy = state.maxBuyLamports(c.mint);
      if (maxBuy < TIER_A_SIZE) continue;
      if (free < TIER_A_SIZE + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: TIER_A_SIZE, max_slippage_bps: SLIPPAGE_BPS });
      free -= TIER_A_SIZE + tx;
      slotsUsed += 1;
      c.doneA = true;
    }
    return orders;
  },
});
