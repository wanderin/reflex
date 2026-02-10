use anchor_lang::prelude::*;

use crate::state::{Pool, ProgramConfig};
use crate::errors::StakingError;
use crate::events::CreatorWalletRotated;

/// Accounts for rotating the creator wallet
/// Only global authority can call
#[derive(Accounts)]
pub struct RotateCreatorWallet<'info> {
    /// The caller - must be global authority only
    #[account(
        constraint = authority.key() == config.authority @ StakingError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    /// Program config
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    /// The pool to update
    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
}

/// Rotate the creator wallet to a new address.
/// Only global authority can call this.
/// 
/// # Arguments
/// * `new_creator` - The new creator wallet pubkey
pub fn rotate_creator_wallet_handler(
    ctx: Context<RotateCreatorWallet>,
    new_creator: Pubkey,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    // Safety check: prevent setting to zero address
    require!(new_creator != Pubkey::default(), StakingError::InvalidWallet);
    
    // Safety check: prevent no-op rotations
    require!(new_creator != pool.creator_wallet, StakingError::CreatorAlreadySet);

    let old_creator = pool.creator_wallet;
    pool.creator_wallet = new_creator;

    emit!(CreatorWalletRotated {
        pool: pool.key(),
        old_creator,
        new_creator,
        rotated_by: ctx.accounts.authority.key(),
        timestamp: clock.unix_timestamp,
    });

    msg!("Creator wallet rotated from {} to {}", old_creator, new_creator);
    Ok(())
}
