use anchor_lang::prelude::*;

/// Emitted when a new pool is initialized
#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub token_mint: Pubkey,
    pub creator_wallet: Pubkey,
    pub tier_multipliers: [u64; 6],
    pub timestamp: i64,
}

/// Emitted when tokens are staked
#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub lot: Pubkey,
    pub amount: u64,
    pub shares: u128,
    pub tier: u8,
    pub unlock_at: i64,
    pub timestamp: i64,
}

/// Emitted when rewards are funded into a pool
#[event]
pub struct RewardsFunded {
    pub pool: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub distributed_amount: u64,
    pub new_acc_sol_per_share: u128,
    pub total_shares: u128,
    pub timestamp: i64,
}

/// Emitted when rewards are claimed
#[event]
pub struct Claimed {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub lot: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

/// Emitted when tokens are unstaked
#[event]
pub struct Unstaked {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub lot: Pubkey,
    pub amount: u64,
    pub shares_removed: u128,
    pub rewards_claimed: u64,
    pub timestamp: i64,
}

/// Emitted when program config is initialized
#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when program authority is updated
#[event]
pub struct AuthorityUpdated {
    pub config: Pubkey,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
    pub timestamp: i64,
}

/// Emitted when a pool's creator wallet is rotated
#[event]
pub struct CreatorWalletRotated {
    pub pool: Pubkey,
    pub old_creator: Pubkey,
    pub new_creator: Pubkey,
    pub rotated_by: Pubkey,
    pub timestamp: i64,
}
