## M-01: Administrative Deadlock in `set_pool_creator` during Authority Transition

**Severity:** Medium
**Status:** Fixed

### Summary
The `handler_set_pool_creator` instruction contains a logic deadlock that makes it impossible to execute during the transition period between transferring the program's upgrade authority and syncing the on-chain `ProgramConfig`.

### Vulnerability Detail
The protocol manages authority in two layers: the `ProgramData` (Solana native upgrade authority) and the `ProgramConfig` PDA (internal state). To update the authority, the user must first change the upgrade authority via CLI and then call `update_authority` to sync the state.

However, `handler_set_pool_creator` enforces two conflicting requirements:
1.  **Account Constraint**: The signer must match `config.authority` (the **Old** authority).
2.  **Handler Logic**: The signer must match the `upgrade_authority` found in `ProgramData` (the **New** authority).

```rust
// programs/sol_memecoin_staking/src/instructions/config.rs

pub struct SetPoolCreator<'info> {
    #[account(
        constraint = authority.key() == config.authority @ StakingError::Unauthorized, // Must be Wallet A
    )]
    pub authority: Signer<'info>,
    // ...
}

pub fn handler_set_pool_creator(...) {
    // ...
    let upgrade_authority = Pubkey::try_from(&program_data[13..45])?;
    require!(
        ctx.accounts.authority.key() == upgrade_authority, // Must be Wallet B
        StakingError::NotUpgradeAuthority
    );
}
```

During the transition window where Wallet A != Wallet B, no signer can satisfy both conditions.

### Impact
The `set_pool_creator` function is completely bricked during the transition period. While this can be resolved by completing the `update_authority` sync, it represents a significant flaw in the administrative state machine that prevents legitimate management actions.

### Recommendation
Update the `SetPoolCreator` struct or handler to allow either the `config.authority` OR the `upgrade_authority` to sign, or remove the dual requirement. Ideally, the `upgrade_authority` should be the ultimate source of truth and should be able to override the `config.authority`.

---

### Team Response

**Fix applied:** `SetPoolCreator` now accepts either `config.authority` OR `upgrade_authority` as the signer, eliminating the deadlock. During an authority transition, the new upgrade authority can call `set_pool_creator` directly without waiting for config sync. Same OR-logic fix applied to `UpdateAuthority` (see H-01). This does not reduce security — the upgrade authority already has ultimate power over the program binary.

---

## M-02: `merge_lots` Bypasses 60-Second Anti-Sandwich Cooldown

**Severity:** Medium
**Status:** Fixed

### Summary

`merge_lots` absorbs the shares of a freshly-staked lot into an older lot without updating the surviving lot's `staked_at`. Because the `claim` instruction's anti-sandwich guard reads `staked_at`, the fresh tokens inherit the old lot's timestamp and become immediately claimable — bypassing the 60-second protection entirely.

### Vulnerability Detail

The anti-sandwich guard in `claim.rs:56` is:

```rust
let min_stake_age: i64 = StakingTier::Flexible.lock_duration_seconds() as i64;
require!(
    clock.unix_timestamp >= stake_lot.staked_at + min_stake_age,
    StakingError::ClaimTooEarly
);
```

This guard assumes `staked_at` reflects when the tokens in the lot were committed. `merge_lots` breaks that assumption: it adds `lot_close.shares` to `lot_keep` (`merge_lots.rs:66-68`) but never updates `lot_keep.staked_at` (`merge_lots.rs:63-77`). The closed lot's freshness is silently discarded.

**Trigger sequence:**
1. Alice stakes 1 token (Flexible, `lot_old`) at T=0 → `staked_at = 0`
2. At T=61: Alice stakes 1,000,000 tokens (Flexible, `lot_new`) → `staked_at = 61`
3. At T=62: `merge_lots(lot_keep=lot_old, lot_close=lot_new)`
   - `lot_old.shares += 1,000,000 shares`
   - `lot_old.staked_at = 0` (UNCHANGED)
   - `lot_new` is closed
4. At T=63: `fund_rewards(1 SOL)`
5. At T=64: Alice calls `claim()`
   - Guard: `64 >= 0 + 60` → PASSES
   - Alice claims rewards proportional to her 1,000,000-share position
   - Those tokens were in the pool for 2 seconds

### Why the Guard Does Not Protect Here

A natural assumption is: "if I staked lot_old 2 minutes ago and lot_new 2 seconds ago, the guard should treat the merged position as 2 seconds old." It does not. The guard reads exactly one value **`lot_keep.staked_at`** and that value never changes during `merge_lots`. It does not average the two stake times, take the more recent one, or account for when the last tokens entered the lot. It simply asks "when was `lot_keep` originally created?" and stops there.

This means the 2-minute-old timestamp on `lot_keep` acts as a permanent pass for any tokens that subsequently merge into it, regardless of how recently those tokens were staked. The guard was designed to answer "has this lot been around long enough?" but after a merge it is actually answering "has this lot's original seed been around long enough?" — two very different questions.

### Impact

An attacker with any lot older than 60 seconds can merge a large freshly-staked lot into it and claim rewards from the very next `fund_rewards` event. This defeats the primary defense against front-run → fund → claim sandwich attacks. The attacker's tokens are locked for 60 more seconds (Flexible `unlock_at` extends), but `claim` only requires `staked_at` to pass — so SOL rewards are extractable immediately.

### Recommendation

In `merge_lots`, update `lot_keep.staked_at` to the maximum of both lots so that merged-in fresh tokens are subject to the full cooldown:

```rust
lot_keep.staked_at = lot_keep.staked_at.max(lot_close.staked_at);
```

---

### Team Response

**Fix applied:** `merge_lots` now updates `lot_keep.staked_at = lot_keep.staked_at.max(lot_close.staked_at)` after merging shares. The surviving lot inherits the newer timestamp, so merged-in fresh tokens are subject to the full 60-second claim cooldown. Users who merge lots must wait 60 seconds from the most recent lot's `staked_at` before claiming. `unlock_at` (unstake timing) is unaffected.

---

## M-03: `add_to_lot` Bypasses 60-Second Anti-Sandwich Cooldown

**Severity:** Medium
**Status:** Fixed

### Summary

`add_to_lot` grows a lot's shares without updating `staked_at`. An attacker with a lot older than 60 seconds can load a large amount into it immediately before a `fund_rewards` call and claim the rewards right after — bypassing the anti-sandwich protection for the freshly added tokens.

### Vulnerability Detail

`add_to_lot` correctly updates `lot.shares`, `lot.reward_debt`, and `lot.unlock_at` (`add_to_lot.rs:88-106`), but never touches `lot.staked_at`. The claim guard reads `staked_at`, so the new tokens inherit the base lot's old timestamp and are immediately claimable if that timestamp is > 60 seconds ago.

Critically, the reward debt for the new shares is calculated at the **current** `acc_sol_per_share` (before any reward distribution), so the new shares participate fully in the next `fund_rewards` event:

```rust
// add_to_lot.rs:82-86
let new_debt = new_shares
    .checked_mul(pool.acc_sol_per_share)  // pre-funding acc
    ...
    .checked_div(SCALE)?;
```

After `fund_rewards` increases `acc_sol_per_share`, the pending rewards on those new shares are positive and immediately claimable.

**Trigger sequence:**
1. Alice stakes 1 token (Flexible) at T=0 → `staked_at = 0`
2. At T=61: Alice calls `add_to_lot(1,000,000 tokens)`
   - `lot.shares += 1,000,000 shares`
   - `lot.staked_at = 0` (UNCHANGED)
   - `lot.unlock_at` extended to T=121 (prevents unstake)
3. At T=62: `fund_rewards(1 SOL)`
4. At T=63: Alice calls `claim()`
   - Guard: `63 >= 0 + 60` → PASSES
   - Alice claims rewards on 1,000,000 tokens added 2 seconds ago

### Impact

Same bypass mechanism as M-02 but through a different instruction. The key difference: `add_to_lot` correctly extends `unlock_at`, so the attacker cannot immediately unstake their tokens. However, `claim` (SOL rewards) is unaffected by `unlock_at` — only `staked_at` matters for the claim guard. SOL rewards on the fresh tokens are extractable immediately after the next `fund_rewards`.

Compared to M-02 (`merge_lots`), this attack requires waiting 60 seconds before loading up (the base lot must already be old), making it slightly less flexible but equally exploitable once the window opens.

### Recommendation

In `add_to_lot`, reset `staked_at` to the current time so the freshness guard applies to the updated position:

```rust
stake_lot.staked_at = clock.unix_timestamp;
```

Note: this changes UX for existing stakers who top up (they must wait another 60 seconds to claim after any add). Consider tracking a separate `last_modified_at` field and using `max(staked_at, last_modified_at)` in the claim guard if the team wants to avoid penalising the original stake's cooldown.

---

### Team Response

**Fix applied:** `add_to_lot` now resets `stake_lot.staked_at = clock.unix_timestamp` after adding tokens. Any top-up resets the 60-second claim cooldown for the entire lot. We accept the UX trade-off — users who add tokens must wait 60 seconds before their next claim. This is consistent with the anti-sandwich guard's purpose: any new tokens entering a lot should be subject to the full cooldown. `unlock_at` (unstake timing) is unaffected — it already correctly extends on add.

---

## M-04: Sole Staker Can Capture Unallocated Rewards via 1-Lamport `sync_rewards` Trigger

**Severity:** Medium
**Status:** Acknowledged — Accepted Risk

### Summary

`sync_rewards` is permissionless and distributes `unallocated_rewards` (SOL that arrived when no stakers existed) to all current stakers whenever it detects new SOL in the vault. Because anyone can send a trivial amount of SOL directly to the vault, a sole staker can force distribution of the entire accumulated `unallocated_rewards` for the cost of 1 lamport.

### Vulnerability Detail

`fund_rewards` guards against pre-staking reward capture with:

```rust
require!(pool.total_shares > 0, StakingError::NoStakers);
```

`sync_rewards` has no equivalent protection. It distributes unallocated rewards to current stakers whenever `vault_balance > expected_balance` (`sync_rewards.rs:46-83`):

```rust
let expected_balance = rent_exempt + total_rewards_funded - total_rewards_claimed;

if vault_balance > expected_balance {
    let new_rewards = vault_balance - expected_balance;
    if pool.total_shares > 0 {
        let total_to_distribute = new_rewards + pool.unallocated_rewards;
        // distributes everything — no authorization check
    }
}
```

The vault is a system-owned PDA. On Solana, any account can receive a system transfer — no program interaction required. Sending 1 lamport to the vault inflates `vault_balance` above `expected_balance` by 1 lamport, which is enough to trigger full distribution of `unallocated_rewards`.

**Trigger sequence:**
1. Pool has no stakers; 100 SOL arrives directly (e.g., pump.fun creator fees)
2. `sync_rewards()` → `unallocated_rewards = 100 SOL`, `total_rewards_funded = 100 SOL`
3. Attacker stakes any amount → becomes sole staker
4. Attacker waits 61 seconds (anti-sandwich clears)
5. Attacker sends 1 lamport directly to `sol_vault`
6. Attacker calls `sync_rewards()`:
   - `new_rewards = 1 lamport`
   - `total_shares > 0` → distributes `1 lamport + 100 SOL`
   - `acc_sol_per_share` spikes
7. Attacker calls `claim()` → receives ~100 SOL
   - Net cost: tx fees + 1 lamport + tokens locked 60 seconds

### Impact

Large `unallocated_rewards` accumulated when a pool has no stakers (common at launch for pump.fun pools receiving creator fees before users arrive) can be captured in their entirety by the first staker who deliberately times their entry and triggers a 1-lamport distribution. Other stakers dilute the attacker's share proportionally, so the attack is most effective when the attacker is the sole or dominant staker.

### Recommendation

Add a minimum stake age or minimum participation threshold before `unallocated_rewards` can be distributed via `sync_rewards`. For example, require the pool to have been active with stakers for a minimum period:

```rust
if pool.unallocated_rewards > 0 {
    require!(
        pool.total_shares >= MIN_SHARES_THRESHOLD,
        StakingError::InsufficientStakers
    );
}
```

Alternatively, accept this as a known design trade-off and document explicitly that the first staker after a reward-accumulation period will capture unallocated rewards proportional to their share dominance.

---

### Team Response

Accepted risk. This scenario is inherent to the permissionless design and only exploitable when the attacker is the sole or dominant staker — which is realistic only at pool launch. Once multiple stakers exist, the attacker's share is diluted proportionally.

`fund_rewards` already blocks funding when `total_shares == 0`, and the 60-second anti-sandwich guard in `claim` prevents single-block sandwich attacks. The remaining attack surface is a deliberate first-staker advantage: someone must be the first to stake and trigger distribution of accumulated SOL. Adding a minimum share threshold would add complexity without meaningfully changing the outcome — a determined attacker can always meet a threshold by staking more.

For pump.fun pools, creator fees that arrive before stakers are parked in `unallocated_rewards` and distributed to the first stakers. We consider this acceptable behavior and will document it explicitly.

---

## M-05: Protocol Fee Bypass via Optional `fee_config` in `fund_rewards`

**Severity:** Medium
**Status:** Fixed

### Summary

`fund_rewards` declares `fee_config` as `Option<Account<'info, ProtocolFeeConfig>>`. When the account is omitted by the caller, `protocol_fee` is unconditionally set to zero. There is no on-chain mechanism to require inclusion of `fee_config` once it has been initialized, creating a permanent and undetectable fee bypass for all authorized funders.

### Vulnerability Detail

The account struct marks `fee_config` as optional with no conditional requirement:

```rust
// programs/sol_memecoin_staking/src/instructions/fund_rewards.rs:47-51

/// Optional: protocol fee config. If absent, no fee is taken.
/// Zero-downtime deploy: existing callers pass None until fee_config is initialized.
#[account(seeds = [b"fee_config"], bump = fee_config.bump)]
pub fee_config: Option<Account<'info, ProtocolFeeConfig>>,
```

In the handler, when the account is absent, the fee resolves to zero via the wildcard arm:

```rust
// programs/sol_memecoin_staking/src/instructions/fund_rewards.rs:69-85

let protocol_fee: u64 = match &ctx.accounts.fee_config {
    Some(fc) if fc.reward_fee_bps > 0 && !pool.fee_exempt() => {
        // fee computed here
    }
    _ => 0,  // None, zero bps, or fee-exempt all collapse here
};
```

The rationale ("zero-downtime deploy: existing callers pass None until fee_config is initialized") addresses the bootstrap window but provides no enforcement path afterwards. Once `fee_config` is deployed, any authorized caller retains the ability to omit it on every subsequent call.

Only `config.authority` and `pool.creator_wallet` can call `fund_rewards`. These are the exclusive parties who fund rewards, meaning the bypass is available to 100% of funders on 100% of funding events.

**Trigger sequence:**
1. Protocol initializes `fee_config` with `reward_fee_bps = 250` (2.5%) and treasury `T`
2. `creator_wallet` constructs a `fund_rewards` tx and intentionally excludes the `fee_config` account
3. Accounts passed: `[funder, config, pool, sol_vault, system_program]` — `fee_config = None`
4. Handler: `ctx.accounts.fee_config` is `None` → `protocol_fee = 0`
5. Full amount enters `sol_vault`; all distributed to stakers
6. Treasury `T` receives 0 lamports (entitled to 2.5%)
7. Step 2–6 can be repeated on every `fund_rewards` call indefinitely

### Impact

The protocol earns zero fee revenue on any `fund_rewards` call where the caller omits `fee_config`. Since all authorized funders have this option permanently, the fee system on the `fund_rewards` path is opt-in by the funder rather than enforced by the protocol. No funds are stolen from users — the bypassed fee simply flows to stakers instead of the treasury.

### Recommendation

Add an on-chain check that requires `fee_config` if the PDA has already been initialized. One approach is to derive the `fee_config` PDA address deterministically and require it when the account exists:

```rust
// Require fee_config if the PDA is already initialized
if let Some(fc) = &ctx.accounts.fee_config {
    // existing fee logic
} else {
    // Check that the fee_config PDA does not exist on-chain
    // If it does, the caller is bypassing fees intentionally
    require!(
        ctx.accounts.fee_config.is_none(),
        StakingError::FeeConfigRequired
    );
}
```

A simpler alternative: make `fee_config` a required account and gate the fee computation on `reward_fee_bps > 0`. This removes the opt-in nature and forces callers to always include the account after deployment.

---

### Team Response

**Fix applied:** `fee_config` is now a required account (not `Option`) in `FundRewards`. `treasury` is also required with an account-level constraint validating `treasury.key() == fee_config.treasury`. The `Option`/`match` pattern has been replaced with direct access. `fee_config` is marked `mut` so that `total_fees_collected` and `pool.reserved[1]` (lifetime per-pool fee counter) are correctly updated when fees are charged — addressing L-04, L-05, and I-08 simultaneously. The zero-downtime deploy concern is moot since `fee_config` is already initialized on mainnet. New deployments must call `initialize_fee_config` before `fund_rewards`.

---

## M-06: Permissionless Fee Bypass in `sync_rewards`

**Severity:** Medium
**Status:** Fixed

### Summary

`sync_rewards` is permissionless — any account can call it — and also accepts `fee_config` as `Option`. When the account is omitted, no protocol fee is charged on externally-received SOL. Since stakers directly benefit from higher rewards (no fee deducted), they have a natural economic incentive to call `sync_rewards` without `fee_config`, routing 100% of external revenue to themselves at the protocol's expense.

### Vulnerability Detail

The same optional pattern as M-05 appears in `sync_rewards`, but the attack surface is wider because there is no authorization gate:

```rust
// programs/sol_memecoin_staking/src/instructions/sync_rewards.rs:30-34

/// Optional: protocol fee config. If absent, no fee is taken.
#[account(seeds = [b"fee_config"], bump = fee_config.bump)]
pub fee_config: Option<Account<'info, ProtocolFeeConfig>>,
```

When `fee_config` is absent:

```rust
// programs/sol_memecoin_staking/src/instructions/sync_rewards.rs:67-78

let protocol_fee: u64 = match &ctx.accounts.fee_config {
    Some(fc) if fc.reward_fee_bps > 0 && !pool.fee_exempt() => {
        // fee computed here
    }
    _ => 0,  // None → full amount to stakers
};
```

`sync_rewards` is the designated path for distributing externally-received SOL (e.g., pump.fun creator fees sent directly to the `sol_vault` PDA). The `sol_vault` is a system-owned PDA that accepts any system transfer with no program involvement, so external SOL accumulates without the protocol having any control over the deposit event.

**Comparison with M-05:**

| | `fund_rewards` bypass (M-05) | `sync_rewards` bypass (M-06) |
|---|---|---|
| Who can exploit | `config.authority`, `creator_wallet` | **Any Solana account** |
| Incentive to exploit | Save 2.5% on reward funding | Get 2.5% more rewards |
| Detection | Off-chain monitoring of accounts list | Off-chain monitoring only |

**Trigger sequence:**
1. pump.fun sends 100 SOL in creator fees directly to `sol_vault` (system transfer — no program involved)
2. `pool.total_shares > 0` — stakers are present
3. Any staker (or a bot watching for external vault deposits) calls `sync_rewards` without `fee_config`
4. Handler: `fee_config = None` → `protocol_fee = 0`
5. `new_rewards = 100 SOL` — fully distributed via `acc_sol_per_share` increase
6. `pool.reserved[0]` is not incremented; no pending fees are recorded
7. Treasury receives 0 lamports (entitled to 2.5 SOL)

### Impact

Every unit of SOL that arrives at a `sol_vault` via external transfer (pump.fun fees, direct donations, etc.) can be distributed to stakers at zero protocol cost, permanently, by any caller. The protocol has no mechanism to enforce fee collection on this revenue path once stakers have economic incentive to bypass it.

No user funds are stolen — the bypassed fee flows to stakers proportionally. The protocol loses its fee revenue on all external-SOL events.

### Recommendation

Same root cause as M-05. The fix must prevent callers from omitting `fee_config` once it has been initialized. For `sync_rewards`, since the call is permissionless, a PDA existence check in the handler is the most practical approach:

```rust
// If fee_config PDA exists on-chain, require it to be passed
// (derive and compare the expected PDA address)
let expected_fee_config = Pubkey::find_program_address(
    &[b"fee_config"],
    ctx.program_id
).0;
// If fee_config account exists at this address, it must be provided
```

Alternatively, restructure `sync_rewards` to have two variants — one for pre-fee-config deployment (no fee) and one for post-deployment (fee required) — controlled by a program-level flag set when `initialize_fee_config` is called.

---

### Team Response

**Fix applied:** Same approach as M-05 — `fee_config` is now a required account (not `Option`) in `SyncRewards`. The `match` pattern has been replaced with direct access to `fee_config.reward_fee_bps`. `fee_config` is not `mut` in `sync_rewards` because fees are accumulated in `pool.reserved[0]` and `pool.reserved[1]` (pool is already `mut`), and `fee_config.total_fees_collected` is updated later in `collect_protocol_fees`. Any caller of `sync_rewards` must now pass the `fee_config` PDA, eliminating the economic incentive to bypass fees.
