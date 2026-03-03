use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::AddedToLot;
use crate::{SCALE, StakingTier};

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct AddToLot<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), stake_lot.lot_seed.to_le_bytes().as_ref()],
        bump = stake_lot.bump,
        has_one = pool,
        constraint = stake_lot.owner == user.key() @ StakingError::Unauthorized,
        constraint = stake_lot.active @ StakingError::LotNotActive,
    )]
    pub stake_lot: Box<Account<'info, StakeLot>>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump = pool.token_vault_bump,
        token::mint = token_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        address = pool.token_mint @ StakingError::TokenMintMismatch,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        address = pool.token_program @ StakingError::InvalidTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn handler_add_to_lot(ctx: Context<AddToLot>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let stake_lot = &mut ctx.accounts.stake_lot;
    let clock = Clock::get()?;

    require!(amount > 0, StakingError::InvalidAmount);

    let tier = stake_lot.get_tier();

    let new_shares = pool.calculate_shares(amount, &tier)?;
    require!(new_shares > 0, StakingError::ZeroShares);

    // Additive debt preserves existing pending rewards exactly:
    // pending_after = (S + dS) * acc/SCALE - (D + dD)
    //   where dD = dS * acc / SCALE
    //   so pending_after = S*acc/SCALE - D = pending_before
    let new_debt = new_shares
        .checked_mul(pool.acc_sol_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(SCALE)
        .ok_or(StakingError::MathOverflow)?;

    stake_lot.amount = stake_lot.amount
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;
    stake_lot.shares = stake_lot.shares
        .checked_add(new_shares)
        .ok_or(StakingError::MathOverflow)?;
    stake_lot.reward_debt = stake_lot.reward_debt
        .checked_add(new_debt)
        .ok_or(StakingError::MathOverflow)?;

    // Extend lock: max(current unlock, now + tier duration)
    let new_unlock = if tier == StakingTier::Permanent {
        i64::MAX
    } else {
        clock.unix_timestamp
            .checked_add(tier.lock_duration_seconds() as i64)
            .ok_or(StakingError::MathOverflow)?
    };
    stake_lot.unlock_at = stake_lot.unlock_at.max(new_unlock);

    pool.total_shares = pool.total_shares
        .checked_add(new_shares)
        .ok_or(StakingError::MathOverflow)?;
    pool.total_staked = pool.total_staked
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;

    // Transfer tokens from user to vault
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.user_token_account.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.token_vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);

    token_interface::transfer_checked(
        cpi_ctx,
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    emit!(AddedToLot {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        lot: stake_lot.key(),
        added_amount: amount,
        new_total_amount: stake_lot.amount,
        added_shares: new_shares,
        new_total_shares: stake_lot.shares,
        new_unlock_at: stake_lot.unlock_at,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Added {} tokens to lot, new total: {}, shares: {}, unlock_at: {}",
        amount,
        stake_lot.amount,
        stake_lot.shares,
        stake_lot.unlock_at
    );

    Ok(())
}
