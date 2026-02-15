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

declare_id!("7mSqZcYPUGm99M6sGpNRHjorbB1NPF3ThyTpEjhkKzKF");

/// Fixed-point scale for acc_sol_per_share: 1e12
/// This allows for precise reward calculations without floating point
pub const SCALE: u128 = 1_000_000_000_000;

/// Staking tier enum with lock durations
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum StakingTier {
    /// 1 minute minimum lock (prevents sandwich attacks)
    Flexible,
    /// 24 hour lock
    Hours24,
    /// 72 hour lock
    Hours72,
    /// 1 week lock
    Week1,
    /// 1 month lock (30 days)
    Month1,
    /// Permanent lock - cannot unstake ever
    Permanent,
}

impl StakingTier {
    /// Get the lock duration in seconds for this tier
    /// Note: Flexible has 1 minute minimum to prevent sandwich attacks on fund_rewards
    pub fn lock_duration_seconds(&self) -> u64 {
        match self {
            StakingTier::Flexible => 60,               // 1 minute (anti-sandwich)
            StakingTier::Hours24 => 24 * 60 * 60,      // 86400
            StakingTier::Hours72 => 72 * 60 * 60,      // 259200
            StakingTier::Week1 => 7 * 24 * 60 * 60,    // 604800
            StakingTier::Month1 => 30 * 24 * 60 * 60,  // 2592000
            StakingTier::Permanent => u64::MAX,        // Never unlocks
        }
    }

    /// Get tier index (0-5)
    pub fn index(&self) -> usize {
        match self {
            StakingTier::Flexible => 0,
            StakingTier::Hours24 => 1,
            StakingTier::Hours72 => 2,
            StakingTier::Week1 => 3,
            StakingTier::Month1 => 4,
            StakingTier::Permanent => 5,
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
    pub fn stake(
        ctx: Context<Stake>,
        amount: u64,
        tier: StakingTier,
        lot_seed: u64,
    ) -> Result<()> {
        handler_stake(ctx, amount, tier, lot_seed)
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
}
