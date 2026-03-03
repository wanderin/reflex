use anchor_lang::prelude::*;

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::LotsMerged;

#[derive(Accounts)]
pub struct MergeLots<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// The lot that will absorb the other lot's stake
    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), lot_keep.lot_seed.to_le_bytes().as_ref()],
        bump = lot_keep.bump,
        has_one = pool,
        constraint = lot_keep.owner == user.key() @ StakingError::Unauthorized,
        constraint = lot_keep.active @ StakingError::LotNotActive,
    )]
    pub lot_keep: Box<Account<'info, StakeLot>>,

    /// The lot that will be closed after merging
    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), lot_close.lot_seed.to_le_bytes().as_ref()],
        bump = lot_close.bump,
        has_one = pool,
        constraint = lot_close.owner == user.key() @ StakingError::Unauthorized,
        constraint = lot_close.active @ StakingError::LotNotActive,
        close = user,
    )]
    pub lot_close: Box<Account<'info, StakeLot>>,

    pub system_program: Program<'info, System>,
}

pub fn handler_merge_lots(ctx: Context<MergeLots>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let lot_keep = &mut ctx.accounts.lot_keep;
    let lot_close = &ctx.accounts.lot_close;
    let clock = Clock::get()?;

    require!(lot_keep.tier == lot_close.tier, StakingError::TierMismatch);
    require!(lot_keep.key() != lot_close.key(), StakingError::InvalidAmount);

    // Fail fast if either lot has a corrupted tier value
    lot_keep.get_tier()?;
    lot_close.get_tier()?;

    let merged_amount = lot_close.amount;
    let merged_shares = lot_close.shares;

    // Additive merge preserves pending rewards exactly:
    // pending_after = (S_a + S_b) * acc/SCALE - (D_a + D_b) = pending_a + pending_b
    lot_keep.amount = lot_keep.amount
        .checked_add(lot_close.amount)
        .ok_or(StakingError::MathOverflow)?;
    lot_keep.shares = lot_keep.shares
        .checked_add(lot_close.shares)
        .ok_or(StakingError::MathOverflow)?;
    lot_keep.reward_debt = lot_keep.reward_debt
        .checked_add(lot_close.reward_debt)
        .ok_or(StakingError::MathOverflow)?;
    lot_keep.total_claimed = lot_keep.total_claimed
        .checked_add(lot_close.total_claimed)
        .ok_or(StakingError::MathOverflow)?;

    // Keep the later unlock time
    lot_keep.unlock_at = lot_keep.unlock_at.max(lot_close.unlock_at);

    pool.active_lots = pool.active_lots
        .checked_sub(1)
        .ok_or(StakingError::MathOverflow)?;

    // No token transfer needed -- tokens stay in the same vault.
    // lot_close is closed via `close = user` constraint, returning ~0.002 SOL rent.

    emit!(LotsMerged {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        lot_kept: lot_keep.key(),
        lot_closed: lot_close.key(),
        merged_amount,
        merged_shares,
        new_total_amount: lot_keep.amount,
        new_total_shares: lot_keep.shares,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Merged lots: kept={}, closed={}, new total amount={}, shares={}",
        lot_keep.key(),
        lot_close.key(),
        lot_keep.amount,
        lot_keep.shares
    );

    Ok(())
}
