## H-01: Permanent Administrative Lockout if Old Authority Key is Lost

**Severity:** High
**Status:** Acknowledged — Accepted Risk (by design)

### Summary
The `update_authority` mechanism requires the current `config.authority` to sign the transaction to sync the state with a new program upgrade authority. If the old authority key is lost after the CLI transfer, the program's administrative state becomes permanently un-syncable and bricked.

### Vulnerability Detail
The `handler_update_authority` is the only mechanism provided to update the `config.authority` field in the `ProgramConfig` PDA. This instruction requires a signature from the **current** `config.authority`.

```rust
// programs/sol_memecoin_staking/src/instructions/config.rs

pub struct UpdateAuthority<'info> {
    #[account(
        constraint = authority.key() == config.authority @ StakingError::Unauthorized,
    )]
    pub authority: Signer<'info>, // Requires signature from the OLD authority
    // ...
}
```

If a developer follows the recommended workflow (CLI transfer first, then on-chain sync) but loses access to the old wallet before the second step, the `ProgramConfig` can never be updated. This is because the `update_authority` handler does not allow the **New** upgrade authority to "claim" the config without the Old authority's permission.

### Impact
Critical administrative functions (creating pools, rotating creator wallets, setting pool creators) will be permanently locked to the old authority address. If that address is inaccessible, the program is effectively bricked for all future admin actions, requiring a full code upgrade (if still possible) to fix.

### Recommendation
Allow the `update_authority` instruction to be signed by the **new** `upgrade_authority` detected in `ProgramData` as a "force-sync" or "claim" mechanism. Since the `upgrade_authority` has the power to upgrade the program's code, they should inherently be trusted to take control of the on-chain configuration state.

---

### Team Response

The dual-signature requirement (`config.authority` + `upgrade_authority`) on `update_authority` is an intentional defense-in-depth measure. If an attacker compromises the admin key alone, they cannot take over the program because they would also need to be the upgrade authority. Allowing the new upgrade authority to unilaterally claim the config would weaken this security boundary.

Our operational procedure calls `update_authority` immediately after any CLI upgrade authority transfer, and the program is managed through a Squads multisig — so the window for key loss between steps is effectively zero. We acknowledge the theoretical risk and accept it as a trade-off for stronger theft protection.
