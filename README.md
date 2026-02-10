# Reflex Staking Protocol

A Solana on-chain program for multi-pool Token-2022 staking with SOL reward distribution.

**Program ID:** `7mSqZcYPUGm99M6sGpNRHjorbB1NPF3ThyTpEjhkKzKF`

## Overview

Users stake Token-2022 tokens into pools and earn SOL rewards proportional to their shares. Longer lock commitments receive a tier bonus on share calculation.

### Share Calculation

```
shares = tokens_staked * tier_multiplier / 10000
```

Linear scaling — no advantage from splitting stakes across multiple accounts.

### Staking Tiers

| Tier | Lock Duration | Multiplier |
|------|---------------|------------|
| Flexible | 1 minute | 1.00x |
| 24 Hours | 24h | 1.05x |
| 72 Hours | 72h | 1.10x |
| 1 Week | 7 days | 1.18x |
| 1 Month | 30 days | 1.30x |
| Permanent | Forever | 1.50x |

Permanent stakes cannot be unstaked. Rewards can still be claimed.

### Reward Distribution

Uses the MasterChef accumulator pattern:
- `acc_sol_per_share` increases when rewards are funded
- `pending = (shares * acc_sol_per_share) - reward_debt`
- `reward_debt` is set on stake/claim to prevent double-claiming

## Instructions

| Instruction | Access | Description |
|-------------|--------|-------------|
| `initialize_config` | Upgrade authority | One-time program setup |
| `update_authority` | Current authority | Transfer authority (must match upgrade authority) |
| `initialize_pool` | Authority | Create a staking pool for a Token-2022 mint |
| `fund_rewards` | Authority or creator wallet | Deposit SOL rewards into a pool |
| `rotate_creator_wallet` | Authority | Change which wallet can fund a pool |
| `stake` | Any user | Stake tokens into a pool |
| `claim` | Lot owner | Claim accumulated SOL rewards |
| `unstake` | Lot owner | Withdraw tokens + rewards, close lot |

## Account Structure

| Account | Seeds | Description |
|---------|-------|-------------|
| Config | `["config"]` | Global program configuration |
| Pool | `["pool", token_mint]` | Pool state per token |
| Token Vault | `["token_vault", pool]` | Holds staked tokens |
| SOL Vault | `["sol_vault", pool]` | Holds reward SOL |
| Stake Lot | `["lot", pool, owner, lot_seed]` | Individual stake position |

## Security

- **Trustless design** — no admin pause or kill-switch
- Authority is verified against the on-chain upgrade authority at initialization and rotation
- 60-second minimum stake age on claims (anti-sandwich)
- Exact reward transfers (no vault over-drain)
- Token-2022 dangerous extensions blocked at pool creation
- `init-if-needed` feature disabled
- Stake lots are closed on unstake, returning rent to the user

### Token-2022 Extension Denylist

The following extensions are blocked at pool initialization:
- TransferFeeConfig
- InterestBearingConfig
- PermanentDelegate
- TransferHook
- ConfidentialTransferMint
- ConfidentialTransferFeeConfig
- NonTransferable

## Build

```bash
anchor build
```

## License

MIT
