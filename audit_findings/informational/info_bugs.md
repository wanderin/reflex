## I-01 Redundant index impl for StakingTier enum
The `StakingTier::index(&self)` is not needed as by default rust arranges the values of the enum in order of index. So no need for the index impl, removing it will reduce the rent consumed as solana counts function and account state to know the rent used for a program, this will be a very negligible reduction.
```rust
pub enum StakingTier {
    /// 1 minute minimum lock (prevents sandwich attacks)
    Flexible, -> 0
    /// 24 hour lock
    Hours24, -> 1
    /// 72 hour lock
    Hours72, -> 2
    /// 1 week lock
    Week1, -> 3
    /// 1 month lock (30 days)
    Month1, -> 4
    /// Permanent lock - cannot unstake ever
    Permanent, -> 5
}
```
---
## I-02 use #[derive(InitSpace)] for account space calculation 
Instead of the manual impl used in the state.rs for the structs (ProgramConfig, Pool, StakeLot) in the [state.rs](/programs/sol_memecoin_staking/src/state.rs), the InitSpace will automatically calculate the size of the Account in future if changes are made and sometimes, dev can forget to update the space where `AccountCouldNotDeserialize` errors will pop up due to wrong accout size parsing.
