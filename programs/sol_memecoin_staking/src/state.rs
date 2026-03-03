use anchor_lang::prelude::*;
use crate::StakingTier;
use crate::errors::StakingError;

/// Program configuration - one per program, controls who can create pools
/// PDA seeds: ["config"]
#[account]
pub struct ProgramConfig {
    /// The authority who can create pools and update config
    pub authority: Pubkey,
    
    /// PDA bump
    pub bump: u8,
    
    /// Dedicated wallet that can only create pools (Pubkey::default() = not set)
    pub pool_creator: Pubkey,
}

impl ProgramConfig {
    /// Space: 8 (discriminator) + 32 (authority) + 1 (bump) + 32 (pool_creator)
    pub const LEN: usize = 8 + 32 + 1 + 32;
}

/// Pool state account - one per token mint
/// PDA seeds: ["pool", token_mint]
#[account]
#[derive(Default)]
pub struct Pool {
    /// The token mint this pool is for
    pub token_mint: Pubkey,
    
    /// The token program ID (SPL Token or Token-2022)
    pub token_program: Pubkey,
    
    /// PDA bump for the pool
    pub bump: u8,
    
    /// PDA bump for the token vault
    pub token_vault_bump: u8,
    
    /// PDA bump for the SOL vault
    pub sol_vault_bump: u8,
    
    /// Reserved byte (was: paused flag, removed for trustlessness)
    pub _padding: u8,
    
    /// Total weighted shares in the pool (sum of all lot shares)
    /// Shares = amount * tier_multiplier / 10000 (linear scaling)
    pub total_shares: u128,
    
    /// Accumulated SOL per share (scaled by SCALE = 1e12)
    /// Updated when rewards are funded
    pub acc_sol_per_share: u128,
    
    /// Total SOL rewards ever funded
    pub total_rewards_funded: u64,
    
    /// Total SOL claimed by users
    pub total_rewards_claimed: u64,
    
    /// Unallocated rewards (when total_shares was 0 during funding)
    pub unallocated_rewards: u64,
    
    /// Tier multipliers in basis points (10000 = 1.0x)
    /// Index: 0=Flexible, 1=24h, 2=72h, 3=1week, 4=1month, 5=Permanent
    pub tier_multipliers: [u64; 6],
    
    /// Total number of active stake lots
    pub active_lots: u64,
    
    /// Total tokens currently staked
    pub total_staked: u64,
    
    /// Timestamp when pool was created
    pub created_at: i64,
    
    /// The token creator's wallet (authorized to fund rewards for this pool)
    pub creator_wallet: Pubkey,
    
    /// Reserved for future use (4 slots = 32 bytes)
    pub reserved: [u64; 4],
}

impl Pool {
    /// Space needed for the Pool account
    /// 8 (discriminator) + 32 (mint) + 32 (token_program) + 1 (bump) + 1 (tv_bump) + 1 (sv_bump)
    /// + 1 (_padding) + 16 (total_shares) + 16 (acc_sol_per_share) + 8 (funded) + 8 (claimed)
    /// + 8 (unallocated) + 48 (multipliers) + 8 (active_lots) + 8 (total_staked) + 8 (created_at)
    /// + 32 (creator_wallet) + 32 (reserved)
    pub const LEN: usize = 8 + 32 + 32 + 1 + 1 + 1 + 1 + 16 + 16 + 8 + 8 + 8 + (6 * 8) + 8 + 8 + 8 + 32 + (4 * 8);
    
    /// Get the multiplier for a tier (in basis points)
    pub fn get_multiplier(&self, tier: &StakingTier) -> u64 {
        self.tier_multipliers[tier.index()]
    }
    
    /// Calculate shares for an amount at a given tier using linear scaling
    /// Formula: shares = amount * multiplier / 10000
    /// 
    /// With linear scaling, there is no incentive to split stakes (no Sybil advantage).
    /// Tier multipliers reward longer lock periods (e.g., 20000 = 2.0x for permanent tier).
    /// Returns MathOverflow on overflow instead of silently returning 0.
    pub fn calculate_shares(&self, amount: u64, tier: &StakingTier) -> Result<u128> {
        let multiplier = self.get_multiplier(tier) as u128;
        let shares = (amount as u128)
            .checked_mul(multiplier)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(StakingError::MathOverflow)?;
        Ok(shares)
    }
}

/// Individual stake lot - tracks one stake position per user
/// PDA seeds: ["lot", pool, owner, lot_seed]
#[account]
#[derive(Default)]
pub struct StakeLot {
    /// The pool this lot belongs to
    pub pool: Pubkey,
    
    /// Owner of this stake lot
    pub owner: Pubkey,
    
    /// Unique seed for this lot (allows multiple lots per user)
    pub lot_seed: u64,
    
    /// PDA bump
    pub bump: u8,
    
    /// Staking tier for this lot
    pub tier: u8, // stored as u8 for space efficiency
    
    /// Amount of tokens staked (raw amount, not weighted)
    pub amount: u64,
    
    /// Weighted shares for this lot
    pub shares: u128,
    
    /// Timestamp when the lot was created
    pub staked_at: i64,
    
    /// Timestamp when the lock expires (0 for flexible, i64::MAX for permanent)
    pub unlock_at: i64,
    
    /// Reward debt for this lot (used in reward calculation)
    /// debt = shares * acc_sol_per_share_at_stake_time / SCALE
    pub reward_debt: u128,
    
    /// Total rewards claimed from this lot
    pub total_claimed: u64,
    
    /// Is this lot active? (false after unstaking)
    pub active: bool,
    
    /// Timestamp of last claim (or staked_at if never claimed)
    pub last_claimed_at: i64,
    
    /// Reserved for future use
    pub reserved: [u64; 3],
}

impl StakeLot {
    /// Space needed for the StakeLot account
    /// 8 (discriminator) + 32 + 32 + 8 + 1 + 1 + 8 + 16 + 8 + 8 + 16 + 8 + 1 + 8 + (3 * 8)
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 1 + 8 + 16 + 8 + 8 + 16 + 8 + 1 + 8 + (3 * 8);
    
    /// Get the staking tier enum from stored u8.
    /// Returns an error for invalid values rather than silently defaulting.
    pub fn get_tier(&self) -> Result<StakingTier> {
        match self.tier {
            0 => Ok(StakingTier::Flexible),
            1 => Ok(StakingTier::Hours24),
            2 => Ok(StakingTier::Hours72),
            3 => Ok(StakingTier::Week1),
            4 => Ok(StakingTier::Month1),
            5 => Ok(StakingTier::Permanent),
            _ => Err(StakingError::InvalidTier.into()),
        }
    }
    
    /// Check if the lot can be unstaked
    pub fn can_unstake(&self, current_time: i64) -> bool {
        if self.tier == 5 {
            // Permanent tier can never unstake
            return false;
        }
        current_time >= self.unlock_at
    }
}
