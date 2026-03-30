use anchor_lang::prelude::*;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    // Required fields
    name: "Reflex Staking Protocol",
    project_url: "https://rflx.fi",
    contacts: "email:admin@rflx.fi",
    policy: "https://github.com/wanderin/reflex/SECURITY.md",

    // Optional fields
    preferred_languages: "en",
    source_code: "https://github.com/wanderin/reflex"
}

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

// Re-export all instruction module contents at crate root for Anchor macro
pub use instructions::config::*;
pub use instructions::initialize_pool::*;
pub use instructions::stake::*;
pub use instructions::claim::*;
pub use instructions::unstake::*;
pub use instructions::fund_rewards::*;
pub use instructions::admin::*;
pub use instructions::sync_rewards::*;
pub use instructions::add_to_lot::*;
pub use instructions::merge_lots::*;
pub use instructions::transfer_stake_lot::*;
pub use instructions::fee_config::*;
pub use instructions::collect_protocol_fees::*;

#[cfg(feature = "mainnet")]
declare_id!("7mSqZcYPUGm99M6sGpNRHjorbB1NPF3ThyTpEjhkKzKF");
#[cfg(feature = "devnet")]
declare_id!("NJhkFnDmd526wGrPgpRGZUsDidGGJ5pFCDZR6nCgift");
#[cfg(feature = "localnet")]
declare_id!("4y5Q3Gd3R2VZjXgzDrMV6qJHP93rSTs5M3GWaMDqoVBn");

/// Fixed-point scale for acc_sol_per_share: 1e12
/// This allows for precise reward calculations without floating point
pub const SCALE: u128 = 1_000_000_000_000;

/// Staking tier enum with lock durations
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum StakingTier {
    /// 1 minute minimum lock (prevents sandwich attacks) — disabled on new pools
    Flexible,
    /// 24 hour lock — disabled on new pools
    Hours24,
    /// 72 hour lock — disabled on new pools
    Hours72,
    /// 1 week lock — disabled on new pools
    Week1,
    /// 1 month lock (30 days) — disabled on new pools
    Month1,
    /// Permanent lock - cannot unstake ever (2.0x multiplier)
    Permanent,
    /// Custom lock - user picks any unlock date (flat 1.0x multiplier)
    Custom,
}

impl StakingTier {
    /// Get the lock duration in seconds for this tier.
    /// Custom returns 0 — actual duration comes from user-supplied unlock_at.
    pub fn lock_duration_seconds(&self) -> u64 {
        match self {
            StakingTier::Flexible => 60,               // 1 minute (anti-sandwich)
            StakingTier::Hours24 => 24 * 60 * 60,      // 86400 1 day
            StakingTier::Hours72 => 72 * 60 * 60,      // 259200 3 days
            StakingTier::Week1 => 7 * 24 * 60 * 60,    // 604800 1 week
            StakingTier::Month1 => 30 * 24 * 60 * 60,  // 2592000 1 month
            StakingTier::Permanent => u64::MAX,         // Never unlocks permanent
            StakingTier::Custom => 0,                   // Duration from unlock_at param
        }
    }

    /// Get tier index (0-6). Custom = 6, not stored in tier_multipliers array.
    pub fn index(&self) -> usize {
        match self {
            StakingTier::Flexible => 0,
            StakingTier::Hours24 => 1,
            StakingTier::Hours72 => 2,
            StakingTier::Week1 => 3,
            StakingTier::Month1 => 4,
            StakingTier::Permanent => 5,
            StakingTier::Custom => 6,
        }
    }
}

/// Default tier multipliers in basis points (10000 = 1.0x)
/// Linear scaling: shares = amount * multiplier / 10000
/// - Proportional rewards (no Sybil advantage from splitting)
/// - Tier bonuses reward longer lock commitments (up to 2.0x for permanent)
pub const DEFAULT_TIER_MULTIPLIERS: [u64; 6] = [
    10_000, // Flexible: 1.00x
    11_500, // 24 hours: 1.15x
    12_500, // 72 hours: 1.25x
    14_000, // 1 week: 1.40x
    17_000, // 1 month: 1.70x
    20_000, // Permanent: 2.00x
];

/// Hard cap on protocol reward fee (10%)
pub const MAX_REWARD_FEE_BPS: u16 = 1_000;

/// Default protocol fee on reward distributions (2.5%)
pub const DEFAULT_REWARD_FEE_BPS: u16 = 250;

/// Custom tier index stored in StakeLot.tier
pub const CUSTOM_TIER_INDEX: u8 = 6;

/// Default multiplier for Custom tier (1.0x = 10000 bps)
pub const DEFAULT_CUSTOM_MULTIPLIER_BPS: u64 = 10_000;

/// Minimum custom lock duration in seconds (anti-sandwich)
pub const MIN_CUSTOM_LOCK_SECONDS: i64 = 60;

#[program]
pub mod sol_memecoin_staking {
    use super::*;

    /// Initialize the program config. Can only be called once.
    /// The signer becomes the program authority who can create pools.
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::config::handler_initialize_config(ctx)
    }

    /// Update the program authority. Only current authority can call.
    /// 
    /// # Arguments
    /// * `new_authority` - The new authority pubkey
    pub fn update_authority(ctx: Context<UpdateAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::config::handler_update_authority(ctx, new_authority)
    }

    /// Set or update the pool_creator role.
    /// Only the global authority can call this.
    /// The pool_creator can only create pools - no other admin powers.
    ///
    /// # Arguments
    /// * `new_pool_creator` - The new pool creator pubkey (Pubkey::default() to disable)
    pub fn set_pool_creator(ctx: Context<SetPoolCreator>, new_pool_creator: Pubkey) -> Result<()> {
        instructions::config::handler_set_pool_creator(ctx, new_pool_creator)
    }

    /// Initialize a new staking pool for a specific token mint.
    /// Only the program authority or pool_creator can create pools.
    /// Creates the pool PDA, token vault, and SOL vault.
    /// 
    /// # Arguments
    /// * `creator_wallet` - The token creator's wallet (for tracking/reference)
    /// * `tier_multipliers` - Optional custom multipliers (basis points). Uses defaults if None.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        creator_wallet: Pubkey,
        tier_multipliers: Option<[u64; 6]>,
    ) -> Result<()> {
        handler_initialize_pool(ctx, creator_wallet, tier_multipliers)
    }

    /// Stake tokens into the pool with a selected tier.
    /// Creates a StakeLot PDA for tracking this stake position.
    ///
    /// # Arguments
    /// * `amount` - Number of tokens to stake (in smallest unit)
    /// * `tier` - The staking tier (lock duration)
    /// * `lot_seed` - Unique seed for this lot (allows multiple lots per user)
    /// * `unlock_at` - Required for Custom tier: unix timestamp when stake unlocks
    pub fn stake(
        ctx: Context<Stake>,
        amount: u64,
        tier: StakingTier,
        lot_seed: u64,
        unlock_at: Option<i64>,
    ) -> Result<()> {
        handler_stake(ctx, amount, tier, lot_seed, unlock_at)
    }

    /// Claim accumulated SOL rewards for a stake lot.
    /// Does not affect staked tokens.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        handler_claim(ctx)
    }

    /// Unstake tokens from a lot (if lock period has passed).
    /// Claims any pending rewards and returns tokens to user.
    /// Fails for Permanent tier lots.
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        handler_unstake(ctx)
    }

    /// Admin: Fund rewards into the pool's SOL vault.
    /// Updates acc_sol_per_share based on total_shares.
    /// 
    /// # Arguments
    /// * `amount` - Lamports to deposit into rewards
    pub fn fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
        handler_fund_rewards(ctx, amount)
    }

    /// Rotate the creator wallet to a new address.
    /// Only global authority can call this.
    /// 
    /// # Arguments
    /// * `new_creator` - The new creator wallet pubkey
    pub fn rotate_creator_wallet(ctx: Context<RotateCreatorWallet>, new_creator: Pubkey) -> Result<()> {
        instructions::admin::rotate_creator_wallet_handler(ctx, new_creator)
    }

    /// Sync externally-received SOL rewards in the sol_vault.
    /// Permissionless -- anyone can call this to distribute rewards
    /// that were sent directly to the sol_vault PDA (e.g., pump.fun creator fees).
    pub fn sync_rewards(ctx: Context<SyncRewards>) -> Result<()> {
        instructions::sync_rewards::handler_sync_rewards(ctx)
    }

    /// Add more tokens to an existing stake lot.
    /// Preserves pending rewards exactly via additive debt.
    /// Extends the lock timer: unlock_at = max(current, now + tier_duration).
    ///
    /// # Arguments
    /// * `amount` - Number of tokens to add (in smallest unit)
    pub fn add_to_lot(ctx: Context<AddToLot>, amount: u64) -> Result<()> {
        instructions::add_to_lot::handler_add_to_lot(ctx, amount)
    }

    /// Merge two stake lots of the same tier into one.
    /// The second lot is closed and its rent (~0.002 SOL) returned to the user.
    /// No token transfer needed -- tokens stay in the same vault.
    pub fn merge_lots(ctx: Context<MergeLots>) -> Result<()> {
        instructions::merge_lots::handler_merge_lots(ctx)
    }

    /// Transfer a stake lot to a new owner.
    /// Atomically closes old lot PDA and creates new one under the recipient.
    /// No tokens move -- they stay in the pool vault. Pending rewards carry over.
    /// Only the current owner can initiate a transfer.
    ///
    /// # Arguments
    /// * `new_lot_seed` - The lot seed for the new owner's PDA
    pub fn transfer_stake_lot(ctx: Context<TransferStakeLot>, new_lot_seed: u64) -> Result<()> {
        instructions::transfer_stake_lot::handler_transfer_stake_lot(ctx, new_lot_seed)
    }

    /// Initialize the protocol fee config PDA.
    /// Only upgrade authority or config.authority can call.
    pub fn initialize_fee_config(
        ctx: Context<InitializeFeeConfig>,
        treasury: Pubkey,
        reward_fee_bps: u16,
    ) -> Result<()> {
        instructions::fee_config::handler_initialize_fee_config(ctx, treasury, reward_fee_bps)
    }

    /// Update the protocol fee config (treasury, fee rate).
    /// Only upgrade authority or config.authority can call.
    pub fn update_fee_config(
        ctx: Context<UpdateFeeConfig>,
        treasury: Pubkey,
        reward_fee_bps: u16,
    ) -> Result<()> {
        instructions::fee_config::handler_update_fee_config(ctx, treasury, reward_fee_bps)
    }

    /// Update per-pool configuration. Authority-only.
    ///
    /// Modifies fee exemption, Custom tier multiplier, and/or tier multipliers
    /// for an existing pool. Changes only affect new stakes — existing lots
    /// retain their stored shares and are unaffected.
    pub fn update_pool_config(
        ctx: Context<UpdatePoolConfig>,
        fee_exempt: Option<u8>,
        custom_multiplier_bps: Option<u64>,
        tier_multipliers: Option<[u64; 6]>,
    ) -> Result<()> {
        instructions::fee_config::handler_update_pool_config(ctx, fee_exempt, custom_multiplier_bps, tier_multipliers)
    }

    /// Collect pending protocol fees from a pool to the treasury.
    /// Permissionless — funds only go to the validated treasury address.
    pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
        instructions::collect_protocol_fees::handler_collect_protocol_fees(ctx)
    }
}
