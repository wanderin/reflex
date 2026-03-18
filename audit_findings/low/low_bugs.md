## L-01: Risky Default to `StakingTier::Permanent` for Invalid Input

**Severity:** Low
**Status:** Fixed ✅

### Summary
The `get_tier` mapping function defaults any invalid input to the `Permanent` tier, which permanently locks user funds.

### Vulnerability Detail
In `state.rs`, the conversion from a `u8` to a `StakingTier` defaults to the most restrictive tier:
```rust
pub fn get_tier(&self) -> StakingTier {
    match self.tier {
        // ... (0-4)
        5 => StakingTier::Permanent,
        invalid => {
            msg!("WARNING: Invalid tier value {}, defaulting to Permanent", invalid);
            StakingTier::Permanent
        }
    }
}
```
If a frontend bug or user error passes an out-of-range value (e.g., `6`), the user's funds are locked forever with no possibility of unstaking.

### Impact
Unexpected permanent loss of funds for users who provide invalid input. While the developer is warned via logs, the action is irreversible.

### Recommendation
Revert the transaction with a clear error message (e.g., `InvalidStakingTier`) instead of defaulting to a permanent lock.

---

### Team Response

Good catch on the defensive programming principle. While the invalid branch is unreachable in practice (`tier` is only ever written via `tier.index() as u8`, which produces 0–5), silently defaulting to the most restrictive tier is the wrong fail-safe direction.

**Fix applied:** `get_tier()` now returns `Result<StakingTier>` and the invalid arm returns `Err(StakingError::InvalidTier)` instead of defaulting to `Permanent`. All callers updated to propagate the error. No effect on existing lots or pools since no stored `tier` value is outside the 0–5 range.

---

## L-02: Unvalidated Multiplier Ordering Allows Reward Gaming

**Severity:** Low
**Status:** Acknowledged — Won't Fix (by design)

### Summary
The `handler_initialize_pool` instruction validates that multipliers are within a specific range but does not enforce that longer lock durations receive higher rewards.

### Vulnerability Detail
Staking rewards are calculated as `shares = amount * multiplier / 10000`. The protocol supports 6 tiers ranging from "Flexible" to "Permanent." While the `DEFAULT_TIER_MULTIPLIERS` are ordered correctly, a pool creator can provide custom `tier_multipliers` where shorter tiers have higher values than longer tiers.

```rust
// programs/sol_memecoin_staking/src/instructions/initialize_pool.rs

for mult in multipliers.iter() {
    require!(*mult >= 10_000 && *mult <= MAX_TIER_MULTIPLIER, StakingError::InvalidMultipliers);
}
// Missing: check that multipliers[i] <= multipliers[i+1]
```

### Impact
1.  **Disincentivizes Locking**: If the "Flexible" tier has the highest multiplier, users will never choose to lock tokens.
2.  **Flash Reward Attacks**: A malicious or compromised admin could set a 10x multiplier on the "Flexible" tier, stake, fund rewards, claim, and unstake in the same minute, draining rewards with zero liquidity risk.

### Recommendation
Add a check in `handler_initialize_pool` to ensure that the multiplier for each tier is greater than or equal to the preceding tier:
```rust
for i in 1..multipliers.len() {
    require!(multipliers[i] >= multipliers[i-1], StakingError::InvalidMultiplierOrdering);
}
```

---

### Team Response

The observation about multiplier ordering is well-reasoned, but this is an intentional trust-model decision. Custom multipliers can **only** be set by `config.authority` or `pool_creator` — both are trusted, team-controlled wallets. Permissionless pool creators always receive the hardcoded `DEFAULT_TIER_MULTIPLIERS` which are correctly ordered.

We intentionally leave ordering flexible for trusted roles because some pools may have legitimate reasons for non-standard multiplier curves (e.g., promotional campaigns where a specific tier is temporarily boosted). Enforcing strict ascending order would remove that flexibility without meaningful security gain, since these wallets already have the power to fund rewards and rotate creator wallets.

---

## L-03: Missing Validation on `fee_exempt` Input Allows Silent Misconfiguration

**Severity:** Low
**Status:** Open

### Summary

`handler_set_pool_config` accepts any `u8` value (0–255) for the `fee_exempt` parameter and writes it directly to `pool._padding` without validation. Since `fee_exempt()` uses a strict equality check (`_padding == 1`), passing any value other than `0` or `1` silently fails to grant exemption while returning no error.

### Vulnerability Detail

In `fee_config.rs`, the `set_pool_config` handler writes the input directly with no bounds check:

```rust
// programs/sol_memecoin_staking/src/instructions/fee_config.rs:235-237

if let Some(exempt) = fee_exempt {
    pool._padding = exempt;  // no validation — any u8 accepted
}
```

The flag is consumed exclusively via `fee_exempt()` in `state.rs`:

```rust
// programs/sol_memecoin_staking/src/state.rs:134

pub fn fee_exempt(&self) -> bool { self._padding == 1 }
```

If an operator calls `set_pool_config` with `fee_exempt = Some(2)` (a reasonable mistake given the boolean intent of the parameter), the transaction succeeds and the event emits `fee_exempt: 2`, but `fee_exempt()` returns `false`. The pool continues charging fees contrary to the operator's intent, with no on-chain error or revert.

Note the contrast with `custom_multiplier_bps`, the parameter immediately below, which correctly guards invalid values:

```rust
// programs/sol_memecoin_staking/src/instructions/fee_config.rs:241-244

require!(
    mult == 0 || (mult >= 10_000 && mult <= 100_000),
    StakingError::InvalidMultipliers
);
```

`fee_exempt` lacks an equivalent guard.

### Impact

An operator intending to grant fee exemption may pass a non-`1` value, causing the pool to silently continue charging fees. No funds are lost or stuck — fees still reach the treasury — but the pool behaves contrary to admin intent with no feedback. The call site is already gated behind `require_authority_or_upgrade`, so exploitation requires a trusted actor mistake.

### Recommendation

Add a `require!` check before writing `_padding`:

```rust
if let Some(exempt) = fee_exempt {
    require!(exempt == 0 || exempt == 1, StakingError::InvalidFeeExempt);
    pool._padding = exempt;
}
```

Alternatively, change the parameter type from `Option<u8>` to `Option<bool>` and convert at the assignment site (`pool._padding = exempt as u8`). This makes the valid domain unambiguous at the type level and eliminates the need for a runtime check.

---

## L-04: `collect_protocol_fees` Is Silently Broken for Pools Using `fund_rewards`

**Severity:** Low
**Status:** Open

### Summary

The protocol has two separate reward-funding paths — `fund_rewards` and `sync_rewards` — that handle protocol fees with incompatible accounting. `collect_protocol_fees` relies on `pool.reserved[0]` (pending fees) being populated, but only `sync_rewards` ever writes to that field. Any pool that uses `fund_rewards` will have `reserved[0] == 0` permanently, causing `collect_protocol_fees` to always revert with `NoFeesToCollect`.

### Vulnerability Detail

**Path A — `fund_rewards`:** The protocol fee is transferred directly from the funder's wallet to the treasury in the same transaction. It never enters the `sol_vault` and `pool.reserved[0]` is never touched.

```rust
// programs/sol_memecoin_staking/src/instructions/fund_rewards.rs:100-111

// Transfer fee directly to treasury (fee never enters vault)
if protocol_fee > 0 {
    system_program::transfer(fee_cpi, protocol_fee)?;
    // reserved[0] is NOT updated here
}
```

**Path B — `sync_rewards`:** The protocol fee stays in the vault as a pending liability. `reserved[0]` is incremented to track it for later collection.

```rust
// programs/sol_memecoin_staking/src/instructions/sync_rewards.rs:121-129

// Accumulate pending fees in pool.reserved[0] and lifetime in pool.reserved[1]
if protocol_fee > 0 {
    pool.reserved[0] = pool.reserved[0].checked_add(protocol_fee)...;
    pool.reserved[1] = pool.reserved[1].checked_add(protocol_fee)...;
}
```

`collect_protocol_fees` is built entirely around the `sync_rewards` model:

```rust
// programs/sol_memecoin_staking/src/instructions/collect_protocol_fees.rs:52-54

let pending = pool.pending_protocol_fees(); // reads reserved[0]
require!(pending > 0, StakingError::NoFeesToCollect); // always fails for fund_rewards pools
```

For any pool that has only ever used `fund_rewards`, `reserved[0]` is always `0`. `collect_protocol_fees` reverts on every call. The instruction is unreachable for this pool type.

| | `fund_rewards` | `sync_rewards` |
|---|---|---|
| Fee routing | Direct to treasury (same tx) | Stays in vault, collected later |
| `reserved[0]` updated | **No** | Yes |
| `total_rewards_funded` | += `net_amount` only | += full amount |
| `collect_protocol_fees` usable | **No — always reverts** | Yes |

### Impact

No funds are lost — fees from `fund_rewards` still reach the treasury immediately. However, `collect_protocol_fees` is dead code for these pools, the two instructions present inconsistent accounting semantics to integrators, and `reserved[1]` (total lifetime fees per pool) will be permanently undercounted for `fund_rewards` pools (see I-08).

### Recommendation

Align the fee accounting in `fund_rewards` with the `sync_rewards` model by accumulating fees into `pool.reserved[0]` and `pool.reserved[1]` before transferring to treasury, or document clearly that `collect_protocol_fees` only applies to `sync_rewards` pools and add an explicit guard or separate instruction path.

---

## L-05: `fee_config.total_fees_collected` Under-Reports Actual Protocol Revenue

**Severity:** Low
**Status:** Open

### Summary

`ProtocolFeeConfig.total_fees_collected` is intended as the program-wide lifetime fee counter. It is only ever incremented in `collect_protocol_fees`, which is only reachable via the `sync_rewards` → vault accumulation → collect path. Fees charged by `fund_rewards` — which transfer directly from the funder to the treasury in the same transaction — are never counted. The global counter permanently under-reports actual protocol revenue.

### Vulnerability Detail

`fee_config.total_fees_collected` has a single write path:

```rust
// programs/sol_memecoin_staking/src/instructions/collect_protocol_fees.rs:90-92

fee_config.total_fees_collected = fee_config.total_fees_collected
    .checked_add(pending)
    .ok_or(StakingError::MathOverflow)?;
```

`collect_protocol_fees` reads `pool.reserved[0]` (pending fees), which is only populated by `sync_rewards`. Fees from `fund_rewards` go directly to treasury in the same transaction and never touch `reserved[0]`, so `collect_protocol_fees` — and by extension `total_fees_collected` — is entirely blind to that revenue path.

| Fee Path | Fee to Treasury | Updates `total_fees_collected` |
|----------|----------------|-------------------------------|
| `fund_rewards` with `fee_config` | ✓ direct, same tx | ✗ |
| `sync_rewards` → `collect_protocol_fees` | ✓ deferred via vault | ✓ |

**Example:**
1. `fee_config` deployed: `reward_fee_bps = 250`
2. `fund_rewards(1_000_000 lamports)` with `fee_config`: 25,000 lamports → treasury; `total_fees_collected` unchanged (= 0)
3. External SOL arrives; `sync_rewards` accrues 2,500 lamports in `reserved[0]`
4. `collect_protocol_fees`: 2,500 lamports → treasury; `total_fees_collected = 2,500`
5. On-chain: `total_fees_collected = 2,500`. Actual revenue: 27,500 lamports. Under-count: 25,000 lamports (91%).

This is the program-wide mirror of the per-pool gap documented in I-08 (`pool.reserved[1]`). Both counters share the same root cause.

### Impact

No funds are lost. The impact is data integrity: any on-chain or off-chain consumer reading `fee_config.total_fees_collected` for revenue accounting, governance metrics, or treasury reconciliation will see systematically understated figures. The discrepancy grows proportionally with every `fund_rewards` call that charges a fee.

### Recommendation

In `handler_fund_rewards`, increment `fee_config.total_fees_collected` when a protocol fee is charged. This requires `fee_config` to be passed as `mut` when a fee applies:

```rust
// programs/sol_memecoin_staking/src/instructions/fund_rewards.rs

if protocol_fee > 0 {
    // existing treasury transfer ...

    // Keep global fee counter accurate for fund_rewards path
    if let Some(fc) = ctx.accounts.fee_config.as_mut() {
        fc.total_fees_collected = fc.total_fees_collected
            .checked_add(protocol_fee)
            .ok_or(StakingError::MathOverflow)?;
    }
}
```

Apply the same fix to `pool.reserved[1]` as recommended in I-08 to make both per-pool and program-wide counters consistent across both funding paths.
