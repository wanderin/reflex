## H-01: Permanent Administrative Lockout if Old Authority Key is Lost

**Severity:** High
**Status:** Fixed

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

**Fix applied:** `UpdateAuthority` now accepts either `config.authority` OR `upgrade_authority` as the signer. If the old config authority key is lost after a CLI transfer, the new upgrade authority can call `update_authority` directly to sync the config — eliminating the permanent lockout risk.

This does not reduce security: the upgrade authority can already upgrade the entire program binary, so granting them config sync access doesn't expand their effective power. The `new_authority` parameter must still match the on-chain `upgrade_authority`, so arbitrary takeover is not possible.

The same OR-logic fix was applied to `SetPoolCreator` (see M-01), resolving the related deadlock.
