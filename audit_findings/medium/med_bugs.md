## M-01: Administrative Deadlock in `set_pool_creator` during Authority Transition

**Severity:** Medium
**Status:** Acknowledged — Accepted Risk

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

This is a direct consequence of the same dual-check design described in H-01. During the brief transition window between transferring upgrade authority and calling `update_authority`, `set_pool_creator` is temporarily unusable. Since our workflow completes both steps in the same session, this deadlock window does not occur in practice. We accept this as part of the same intentional trade-off documented in H-01.
