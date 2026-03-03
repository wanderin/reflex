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
