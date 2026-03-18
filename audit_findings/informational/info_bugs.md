## I-01: Redundant `index` Implementation for `StakingTier`

**Severity:** Informational
**Status:** Acknowledged — Won't Fix

### Summary
The manual `index(&self)` implementation for the `StakingTier` enum is redundant as Rust enums with a `#[repr(u8)]` or default discriminants already follow this ordering.

### Detail
Removing redundant logic reduces the program size and simplifies maintenance. Since the `StakingTier` is already mapped from a `u8` in `StakeLot::get_tier()`, the explicit index function adds no value.

### Recommendation
Remove the manual index mapping and use the enum discriminant directly or rely on the `u8` stored in the `StakeLot` state.

### Team Response

The manual `index()` method is intentionally explicit for readability. While Rust enum discriminants could serve the same purpose with `#[repr(u8)]` and `as usize`, the explicit match is self-documenting and makes the mapping obvious to auditors and future contributors. The program size overhead is negligible.

---

## I-02: Use `#[derive(InitSpace)]` for Robust Space Calculation

**Severity:** Informational
**Status:** Acknowledged — Won't Fix (migration risk)

### Summary
Account sizes in `state.rs` are calculated using manual constants. Using Anchor's `InitSpace` macro is a safer and more maintainable approach.

### Detail
Manual space calculations (e.g., `8 + 32 + 1 + 32`) are prone to human error, especially when fields are added or modified during development. If the `LEN` constant is not updated to match the struct, the program will fail to deserialize accounts or may corrupt data.

### Recommendation
Implement `#[derive(InitSpace)]` on all state structs and use `Type::INIT_SPACE` for account allocation in the instruction structs.

### Team Response

Sound recommendation for new programs. However, switching to `InitSpace` on a deployed program carries risk — if the macro calculates even one byte differently from our manual constants, existing accounts become undeserializable. Since the current manual constants are verified correct and match the deployed account layouts, we prefer stability. We will consider `InitSpace` for future programs.

---

## I-03: Prefer Associated Token Accounts for User Holdings

**Severity:** Informational
**Status:** Acknowledged — Won't Fix (by design)

### Summary
The current `stake` instruction's `user_token_account` accepts any valid `TokenAccount` owned by the user for the specific mint, rather than explicitly enforcing the use of an Associated Token Account (ATA).

### Detail
While the existing constraints (`token::mint` and `token::authority`) ensure the provided `TokenAccount` belongs to the user and holds the correct token, they do not guarantee it is an ATA. This deviates from Solana's standard token interaction pattern.

Using ATAs offers:
*   **Standardization:** Aligns with the widely adopted best practice for user token ownership on Solana.
*   **Clarity and Predictability:** Simplifies client-side interactions as the ATA address is deterministically derived.
*   **Enhanced Security:** Provides a stronger guarantee that the program is interacting with the user's canonical token account, reducing potential edge cases or misuse of custom token accounts.

### Recommendation
Modify the `user_token_account` in the `Stake` instruction to explicitly enforce it as an Associated Token Account using Anchor's `associated_token::mint` and `associated_token::authority` constraints.

### Team Response

Enforcing ATA-only constraints would prevent users who hold tokens in non-ATA accounts (e.g., multisig treasuries, custom PDAs, or secondary token accounts) from staking. The current constraints (`token::mint`, `token::authority`, `token::token_program`) already guarantee the account belongs to the signer and holds the correct mint, which is sufficient for security. We prefer the more permissive approach for a permissionless staking protocol.

---

## I-04: Redundant `amount` and `tier` in `Stake` Instruction Context

**Severity:** Informational
**Status:** Acknowledged — No Change Needed

### Summary
The `amount: u64` and `tier: StakingTier` fields in the `Stake` instruction context struct are redundant as they are already passed as direct instruction arguments to the `stake` handler function.

### Detail
Including `amount: u64` and `tier: StakingTier` within the `Stake` struct duplicates information that is already provided as explicit instruction arguments. The Anchor framework automatically handles the deserialization of instruction arguments, making these fields in the context struct unnecessary. Removing them simplifies the instruction's signature.

### Recommendation
Remove the `amount: u64` and `tier: StakingTier` fields from the `Stake` instruction context struct in `programs/sol_memecoin_staking/src/instructions/stake.rs`. The values can be directly accessed as parameters of the `stake` handler function.

### Team Response

The `#[instruction(amount: u64, tier: StakingTier, lot_seed: u64)]` annotation is required by Anchor for PDA seed derivation. The `lot_seed` parameter is used in the `stake_lot` PDA seeds, and Anchor deserializes instruction arguments positionally — all preceding arguments (`amount`, `tier`) must be listed in the `#[instruction]` attribute even if they aren't used in account constraints directly. Removing them would break PDA derivation.

---

## I-05: Dead `active` Field

**Severity:** Informational
**Status:** Acknowledged — Won't Fix (layout stability)

### Description
The `active` field is set to `true` on stake but never set to `false`. On unstake, the lot account is closed. The `active == false` state is unreachable for any existing account.

### Root Cause
- `stake.rs:117` — `stake_lot.active = true` (only write to the field)
- `unstake.rs:31-33` — `close = user` closes the account instead of setting `active = false`
- No code path ever sets `active = false`; the constraint `stake_lot.active` is always true for valid lots:

```rust
// stake.rs:117
stake_lot.active = true;

// unstake.rs — lot is closed, not marked inactive
#[account(..., close = user)]
pub stake_lot: Account<'info, StakeLot>,
```

### Recommendation
Either remove the `active` field and rely on account existence, or set `active = false` before closing for auditability.

### Team Response

Correct observation — the field is always `true` for existing accounts since lots are closed on unstake rather than marked inactive. However, removing the field would change the account layout and break deserialization of all existing `StakeLot` accounts in production. The 1-byte overhead per lot is acceptable for layout stability. We may repurpose this field in a future version.


---

## I-06: Permissionless Pool Creation Enables Fake Pool Phishing

**Severity:** Informational
**Status:** Open

### Summary
Any user can create a staking pool for any SPL token mint. There is no on-chain validation that the token being pooled is a legitimate or recognized asset. This enables an attacker to create a pool for a fake copycat token and trick users into staking in the wrong pool.

### Detail
Pool creation in `initialize_pool.rs` is explicitly permissionless — the comment on line 22 reads `"Anyone can create a pool (permissionless)"`. The pool PDA is seeded only by the token mint address:

```rust
seeds = [b"pool", token_mint.key().as_ref()]
```

The contract correctly enforces that staked tokens must match the pool's `token_mint`, meaning cross-pool contamination is impossible. However, there is no on-chain registry or whitelist that distinguishes the real project pool from an attacker-created pool for a look-alike token.

**Attack scenario:**
1. A legitimate project creates Pool A for their memecoin and funds it with SOL rewards.
2. An attacker mints a fake token with the same name and symbol, then creates Pool B for it without funding any SOL.
3. A user who receives the wrong pool address (e.g., via a phishing link or misleading UI) stakes into Pool B.
4. The user's tokens are locked in Pool B with no SOL rewards to claim.

Note: An attacker staking their fake tokens into a legitimate funded pool is **not possible** — each pool PDA is isolated to its own mint. The risk here is purely social engineering and user confusion, not direct fund theft from the protocol.

**Attack scenario 2 — Majority share griefing / reward drain:**
1. An attacker creates a pool for a worthless token they control and mints a large supply at near-zero cost.
2. The attacker stakes the vast majority of that supply into the pool using the Permanent tier (2x multiplier), accumulating dominant share weight.
3. Through phishing, a fake UI, or misleading social media, a victim is convinced to send SOL directly to the pool's SOL vault address (or call `fund_rewards`) believing they are funding a legitimate project's reward pool.
4. `sync_rewards` is called (permissionlessly by anyone, including the attacker), which distributes the newly detected SOL across all shares proportional to weight.
5. Because the attacker holds the majority of shares, they claim the majority of the victim's deposited SOL immediately via `claim`.
6. The attacker walks away with most of the victim's SOL; the victim is left with staked worthless tokens and negligible rewards.


### Recommendation
This is a design-level consideration rather than a code bug. Mitigations belong at the frontend/UX layer:
- The official UI should only surface pools for verified/whitelisted mint addresses.
- Pool addresses should be prominently shown and cross-referenced with official project communications.
- Consider maintaining an off-chain registry of canonical pool addresses per project.

### Team Response

Both scenarios are valid observations about the permissionless nature of pool creation, and we agree the mitigations belong at the frontend layer — not on-chain. Adding an on-chain whitelist would contradict the trustless, permissionless design of the protocol.

Our official frontend at rflx.fi only surfaces pools that have been verified by the team. Each pool is cross-referenced against its canonical mint address and displayed with clear token metadata. Users interacting through our UI are not exposed to fake or unverified pools.

For the reward drain scenario: any user who calls `fund_rewards` or sends SOL directly to a vault address on a pool they did not independently verify is operating outside our official UI. We will add prominent warnings in our documentation advising users to only interact through the official frontend and to verify pool addresses through official channels before funding.

**Status:** Acknowledged — Mitigated at the frontend layer

---

## I-07: `last_claimed_at` Field Is Written But Never Enforced

**Severity:** Informational
**Status:** Acknowledged — Won't Fix (analytics use)

### Summary

`StakeLot.last_claimed_at` is set by three instructions but is never read in any security guard. Comments and rationale throughout the code treat it as an active cooldown mechanism, but the actual anti-sandwich enforcement uses `staked_at` exclusively. The field is dead state.

### Detail

`last_claimed_at` is written in:
- `stake.rs:118` — initialized to stake time
- `claim.rs:113` — updated after each successful claim
- `transfer_stake_lot.rs:83` — reset to `clock.unix_timestamp` with the comment:
  ```rust
  new_lot.last_claimed_at = clock.unix_timestamp; // Reset 60s anti-sandwich cooldown
  ```

It is read in zero security-relevant locations. The actual anti-sandwich guard (`claim.rs:56`) reads `staked_at`:

```rust
require!(clock.unix_timestamp >= stake_lot.staked_at + min_stake_age);
```

This creates two misleading code patterns:

1. `transfer_stake_lot.rs:83` — the comment claims this line "resets the 60s anti-sandwich cooldown." It does not. Resetting `last_claimed_at` has no effect on any guard.

2. `transfer_stake_lot.rs:58-62` — the self-transfer guard cites cooldown-reset abuse as its rationale:
   ```rust
   // Prevent self-transfer (could abuse cooldown reset)
   require!(owner != new_owner, StakingError::SelfTransferNotAllowed);
   ```
   The mechanism it's protecting against is not enforced anywhere in the code.

### Impact

No funds are at risk under the current code. The concern is forward-looking:

- A developer reading the field name, the comment, and the self-transfer guard rationale will reasonably conclude that `last_claimed_at` enforces a per-claim cooldown. It does not.
- Off-chain tooling or indexers that consume `last_claimed_at` to determine claim eligibility will produce incorrect results.
- A future instruction that relies on `last_claimed_at` as a security gate will ship with a broken assumption.

### Recommendation

Either enforce the field or remove it. Two options:

**Option A — Enforce it:** Update the claim guard to use `last_claimed_at` for rate-limiting repeat claims (in addition to or instead of `staked_at`):
```rust
require!(
    clock.unix_timestamp >= stake_lot.last_claimed_at + min_stake_age,
    StakingError::ClaimTooEarly
);
```

**Option B — Remove it:** Delete `last_claimed_at` from `StakeLot`, remove all writes, and update the comments and self-transfer guard rationale to reflect the actual guard mechanism (`staked_at`). Note that removing the field changes the account layout and would break deserialization of existing accounts in production.

---

### Team Response

Correct observation — `last_claimed_at` is not enforced on-chain. We intentionally keep the field for off-chain analytics: it allows indexers and dashboards to track when each lot last claimed rewards without replaying transaction history.

**Comment fix applied:** The misleading comment in `transfer_stake_lot.rs` ("Reset 60s anti-sandwich cooldown") has been corrected to "Reset for analytics tracking" to accurately reflect the field's purpose. The anti-sandwich guard uses `staked_at` exclusively, as the auditor correctly identified.

Removing the field is not viable due to account layout stability (same reasoning as I-05). We will not add on-chain enforcement for `last_claimed_at` — the 60-second anti-sandwich guard via `staked_at` is sufficient and is now correctly applied across `merge_lots` (M-02) and `add_to_lot` (M-03).

---

## I-08: `pool.reserved[1]` (`total_protocol_fees`) Undercounts Lifetime Fees for `fund_rewards` Pools

**Severity:** Informational
**Status:** Open

### Summary

`pool.reserved[1]` is intended to track the lifetime total of protocol fees collected from a pool. However, it is only ever incremented by `sync_rewards`. Fees taken via `fund_rewards` — which go directly to treasury without touching the vault — are never reflected in this field, making it an inaccurate accounting record for any pool that uses `fund_rewards`.

### Detail

`pool.reserved[1]` (accessed via `pool.total_protocol_fees()`) is incremented in exactly one place:

```rust
// programs/sol_memecoin_staking/src/instructions/sync_rewards.rs:126-129

pool.reserved[1] = pool.reserved[1]
    .checked_add(protocol_fee)
    .ok_or(StakingError::MathOverflow)?;
```

In `fund_rewards`, the protocol fee is computed and transferred directly to treasury. `reserved[1]` is never touched:

```rust
// programs/sol_memecoin_staking/src/instructions/fund_rewards.rs:100-111

// Transfer fee directly to treasury (fee never enters vault)
if protocol_fee > 0 {
    system_program::transfer(fee_cpi, protocol_fee)?;
    // reserved[1] is NOT updated here
}
```

For any pool that uses `fund_rewards`, `pool.total_protocol_fees()` will always return `0` (or only the fees from `sync_rewards` calls, if both paths are used). The true lifetime fee total for the pool is unquantifiable from on-chain state alone.

### Impact

No funds are affected. This is a data accuracy issue: off-chain indexers, dashboards, or analytics tools that read `pool.reserved[1]` to report per-pool fee revenue will produce incorrect (understated) figures for `fund_rewards` pools. `ProtocolFeeConfig.total_fees_collected` (the program-wide counter) has the same gap — it is only incremented in `collect_protocol_fees`, which itself is only reachable via the `sync_rewards` path (see L-04).

### Recommendation

In `handler_fund_rewards`, add the same `reserved[1]` increment that `sync_rewards` performs:

```rust
if protocol_fee > 0 {
    // existing treasury transfer ...

    // Mirror the accounting sync_rewards performs
    pool.reserved[1] = pool.reserved[1]
        .checked_add(protocol_fee)
        .ok_or(StakingError::MathOverflow)?;
}
```

This keeps the per-pool lifetime fee counter accurate regardless of which funding path is used.

---

## I-09: `fee_config.authority` Is Dead State — Diverges from `config.authority` on Rotation

**Severity:** Informational
**Status:** Open

### Summary

`ProtocolFeeConfig.authority` is set to `config.authority` at initialization time but is never updated if `config.authority` is subsequently rotated via `update_authority`. It is also never read in any authorization check — all auth logic reads `config.authority` directly. The field is dead state that diverges silently from the true governance authority after any rotation.

### Detail

The field is written exactly once, at initialization:

```rust
// programs/sol_memecoin_staking/src/instructions/fee_config.rs:102

fee_config.authority = ctx.accounts.config.authority;
```

Every authorization check in `fee_config.rs` bypasses it and reads `ProgramConfig.authority` directly:

```rust
// programs/sol_memecoin_staking/src/instructions/fee_config.rs:33-44

fn require_authority_or_upgrade(
    signer: &Pubkey,
    config_authority: &Pubkey,  // always passed from config.authority, not fee_config.authority
    program_data: &AccountInfo,
) -> Result<()> { ... }

// Called as:
require_authority_or_upgrade(
    &ctx.accounts.authority.key(),
    &ctx.accounts.config.authority,  // ← config, not fee_config
    &ctx.accounts.program_data.to_account_info(),
)?;
```

`update_authority` only updates `ProgramConfig.authority`:

```rust
// programs/sol_memecoin_staking/src/instructions/config.rs

config.authority = new_authority;
// fee_config.authority is NOT updated — no mechanism exists to update it
```

After an authority rotation:
- `config.authority` = new authority (correct, enforced)
- `fee_config.authority` = old authority (stale, never enforced)

### Impact

No funds are at risk and no authorization check is weakened under the current code — all security-critical paths read `config.authority`. The concerns are forward-looking:

1. **Stale governance data:** On-chain explorers and indexers reading `fee_config.authority` to determine who governs the fee system will display the wrong key after any rotation.
2. **Future regression risk:** If a future instruction is added that reads `fee_config.authority` for authorization (the field name strongly implies this intent), it will silently use a stale, potentially no-longer-trusted key.
3. **Audit surface:** The field creates confusion for future auditors who must trace why two authority fields exist and which one is actually enforced.

### Recommendation

Choose one of:

**Option A — Remove the field.** Since `fee_config.authority` is never read, remove it from `ProtocolFeeConfig` and its initialization. Note: this changes the account layout and would break deserialization of any already-deployed `fee_config` account. Consider a migration or realloc if the account is already live.

**Option B — Sync on rotation.** Add `fee_config` as a mutable account to `UpdateAuthority` and update it alongside `config.authority`:

```rust
// In update_authority handler:
config.authority = new_authority;
fee_config.authority = new_authority;  // keep in sync
```

**Option C — Document as analytics-only.** If the field is retained for off-chain tooling, add a comment explicitly stating it is not enforced on-chain and may be stale — matching the pattern used for `last_claimed_at` (I-07).