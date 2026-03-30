## L-06: `initialize_pool` Validates Tier Multipliers That Are Immediately Overwritten

**Severity:** Low
**Status:** Fixed

### Summary

`handler_initialize_pool` validates all six `tier_multipliers` values against a `>= 10_000` floor, then unconditionally overwrites indices 0–4 to `0`. The validation and the override are contradictory: the caller must supply values that pass validation but are never used.

### Vulnerability Detail

When a trusted caller (authority or pool_creator) passes custom `tier_multipliers`, every element is validated:

```rust
// programs/sol_memecoin_staking/src/instructions/initialize_pool.rs:163-166 (before fix)

for mult in multipliers.iter() {
    require!(*mult >= 10_000 && *mult <= MAX_TIER_MULTIPLIER, StakingError::InvalidMultipliers);
}
```

Immediately after pool state is written, indices 0–4 are zeroed:

```rust
// programs/sol_memecoin_staking/src/instructions/initialize_pool.rs:244-248

pool.tier_multipliers[0] = 0; // Flexible: disabled
pool.tier_multipliers[1] = 0; // 24h: disabled
pool.tier_multipliers[2] = 0; // 72h: disabled
pool.tier_multipliers[3] = 0; // 1week: disabled
pool.tier_multipliers[4] = 0; // 1month: disabled
```

This creates two problems:

1. **Misleading validation:** A caller who passes `[0, 0, 0, 0, 0, 20000]` — the correct intent for a Custom+Permanent pool — gets rejected because `0 < 10_000`. They must pass dummy values like `[10000, 10000, 10000, 10000, 10000, 20000]` that are immediately discarded.

2. **Silent discard:** A caller who passes `[15000, 12000, 14000, 16000, 18000, 25000]` expecting custom multipliers on all tiers sees them pass validation but gets `[0, 0, 0, 0, 0, 25000]` stored. The intent and the outcome diverge silently.

### Impact

No funds at risk. The impact is operational confusion: callers must understand that only `multipliers[5]` (Permanent) survives initialization, and they cannot express "disable tier" intent (`0`) through the parameter because validation rejects it. All pools end up with the correct Custom+Permanent configuration regardless, so the protocol functions correctly.

### Recommendation

Validate only the Permanent tier (index 5), since indices 0–4 are unconditionally overwritten:

```rust
require!(
    multipliers[5] >= 10_000 && multipliers[5] <= MAX_TIER_MULTIPLIER,
    StakingError::InvalidMultipliers
);
```

---

### Team Response

**Fix applied:** Validation now only checks `multipliers[5]` (Permanent tier). Indices 0–4 are zeroed regardless of input, so validating them was misleading. Callers no longer need to supply dummy values for disabled tiers.

---

## L-07: `transfer_stake_lot` Zeroes StakeLot `reserved` Fields on Transfer

**Severity:** Low
**Status:** Acknowledged — Accepted Risk

### Summary

When a stake lot is transferred to a new owner via `transfer_stake_lot`, the new lot's `reserved` field is hardcoded to `[0; 3]` instead of being copied from the original lot. If `StakeLot.reserved` is ever repurposed to store per-lot data (as `Pool.reserved` has been for protocol fees and custom multipliers), transfers will silently drop that data.

### Vulnerability Detail

In `transfer_stake_lot.rs`, the new lot is initialized with zeroed reserved fields:

```rust
// programs/sol_memecoin_staking/src/instructions/transfer_stake_lot.rs:84

new_lot.reserved = [0; 3];
```

All other lot fields are faithfully copied: `pool`, `tier`, `amount`, `shares`, `staked_at`, `unlock_at`, `reward_debt`, `total_claimed`. Only `reserved` is reset.

Currently, `StakeLot.reserved` is unused — no instruction reads or writes to it. However, `Pool.reserved` was similarly "unused" until the protocol fee system repurposed `reserved[0]`, `reserved[1]`, and `reserved[2]` for pending fees, lifetime fees, and custom multiplier. The same pattern applied to `StakeLot.reserved` would silently break on transfer.

### Impact

No current impact. `StakeLot.reserved` is zero-initialized at stake time and never written to by any instruction. The risk is forward-looking: if a future upgrade stores per-lot data in `reserved` (e.g., a per-lot fee counter, referral tracking, or tier metadata), `transfer_stake_lot` will silently drop that data for the recipient.

### Recommendation

Copy `reserved` from the old lot instead of zeroing:

```rust
new_lot.reserved = old_lot.reserved;
```

This is a one-line change with no functional impact today but prevents data loss if `reserved` is repurposed in a future upgrade.

---

### Team Response

**Acknowledged — Accepted Risk.** `StakeLot.reserved` is currently unused and zero-initialized. Zeroing on transfer is functionally correct today. If we repurpose these fields in a future upgrade, we will update `transfer_stake_lot` to copy them as part of that change. Fixing it preemptively would add no value since the fields are not yet load-bearing.
