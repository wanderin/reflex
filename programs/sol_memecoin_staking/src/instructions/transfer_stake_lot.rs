use anchor_lang::prelude::*;

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::StakeLotTransferred;

#[derive(Accounts)]
#[instruction(new_lot_seed: u64)]
pub struct TransferStakeLot<'info> {
    /// Current lot owner — signs, pays new PDA rent, receives old PDA rent refund (~net zero)
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Recipient address (does not need to sign)
    /// CHECK: Any valid pubkey can receive a stake lot. Validated not default/self in handler.
    pub new_owner: UncheckedAccount<'info>,

    /// The pool (not mutated — active_lots is net zero: -1 close, +1 init)
    #[account(
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// The existing stake lot to close
    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), owner.key().as_ref(), old_lot.lot_seed.to_le_bytes().as_ref()],
        bump = old_lot.bump,
        has_one = pool,
        constraint = old_lot.owner == owner.key() @ StakingError::Unauthorized,
        constraint = old_lot.active @ StakingError::LotNotActive,
        close = owner,
    )]
    pub old_lot: Box<Account<'info, StakeLot>>,

    /// The new stake lot PDA for the recipient
    #[account(
        init,
        payer = owner,
        space = StakeLot::LEN,
        seeds = [b"lot", pool.key().as_ref(), new_owner.key().as_ref(), new_lot_seed.to_le_bytes().as_ref()],
        bump,
    )]
    pub new_lot: Box<Account<'info, StakeLot>>,

    pub system_program: Program<'info, System>,
}

pub fn handler_transfer_stake_lot(
    ctx: Context<TransferStakeLot>,
    new_lot_seed: u64,
) -> Result<()> {
    let old_lot = &ctx.accounts.old_lot;
    let new_lot = &mut ctx.accounts.new_lot;
    let clock = Clock::get()?;

    // Prevent self-transfer (could abuse cooldown reset)
    require!(
        ctx.accounts.owner.key() != ctx.accounts.new_owner.key(),
        StakingError::SelfTransferNotAllowed
    );

    // Prevent transfer to zero address
    require!(
        ctx.accounts.new_owner.key() != Pubkey::default(),
        StakingError::InvalidWallet
    );

    // Copy all stake data from old lot to new lot
    new_lot.pool = old_lot.pool;
    new_lot.owner = ctx.accounts.new_owner.key();
    new_lot.lot_seed = new_lot_seed;
    new_lot.bump = ctx.bumps.new_lot;
    new_lot.tier = old_lot.tier;
    new_lot.amount = old_lot.amount;
    new_lot.shares = old_lot.shares;
    new_lot.staked_at = old_lot.staked_at;
    new_lot.unlock_at = old_lot.unlock_at;
    new_lot.reward_debt = old_lot.reward_debt;
    new_lot.total_claimed = old_lot.total_claimed;
    new_lot.active = true;
    new_lot.last_claimed_at = clock.unix_timestamp; // Reset 60s anti-sandwich cooldown
    new_lot.reserved = [0; 3];

    // old_lot is closed via `close = owner` constraint
    // Pool state unchanged: active_lots net zero, total_shares unchanged, total_staked unchanged

    emit!(StakeLotTransferred {
        pool: ctx.accounts.pool.key(),
        old_owner: ctx.accounts.owner.key(),
        new_owner: ctx.accounts.new_owner.key(),
        old_lot: ctx.accounts.old_lot.key(),
        new_lot: new_lot.key(),
        amount: new_lot.amount,
        shares: new_lot.shares,
        tier: new_lot.tier,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Transferred stake lot: old_owner={}, new_owner={}, amount={}, shares={}",
        ctx.accounts.owner.key(),
        ctx.accounts.new_owner.key(),
        new_lot.amount,
        new_lot.shares,
    );

    Ok(())
}
