use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::Claimed;
use crate::{SCALE, StakingTier};

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The user claiming rewards
    #[account(mut)]
    pub user: Signer<'info>,

    /// The pool
    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    /// The stake lot to claim from
    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), stake_lot.lot_seed.to_le_bytes().as_ref()],
        bump = stake_lot.bump,
        has_one = pool,
        constraint = stake_lot.owner == user.key() @ StakingError::Unauthorized,
        constraint = stake_lot.active @ StakingError::LotNotActive,
    )]
    pub stake_lot: Account<'info, StakeLot>,

    /// SOL vault PDA
    /// CHECK: PDA that holds SOL, validated by seeds
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump = pool.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_claim(ctx: Context<Claim>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let stake_lot = &mut ctx.accounts.stake_lot;
    let clock = Clock::get()?;

    // Anti-sandwich: require minimum stake age before claiming rewards
    // Prevents single-block front-run → fund_rewards → claim attack.
    // References the Flexible tier's lock duration to stay in sync with lib.rs.
    let min_stake_age: i64 = StakingTier::Flexible.lock_duration_seconds() as i64;
    require!(
        clock.unix_timestamp >= stake_lot.staked_at + min_stake_age,
        StakingError::ClaimTooEarly
    );

    // Calculate pending rewards
    // pending = (shares * acc_sol_per_share / SCALE) - reward_debt
    let accumulated = stake_lot.shares
        .checked_mul(pool.acc_sol_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(SCALE)
        .ok_or(StakingError::MathOverflow)?;
    
    let pending = accumulated
        .checked_sub(stake_lot.reward_debt)
        .ok_or(StakingError::MathOverflow)?;

    // Safe conversion from u128 to u64 with overflow check
    let pending_lamports: u64 = pending
        .try_into()
        .map_err(|_| StakingError::MathOverflow)?;
    
    require!(pending_lamports > 0, StakingError::NoRewardsToClaim);

    // Check SOL vault has sufficient funds
    // Note: ~0.0009 SOL rent dust may be trapped in vault as a known limitation.
    // This is preferable to the "drain everything" approach which overpays one user
    // at the expense of others.
    let sol_vault_balance = ctx.accounts.sol_vault.lamports();
    require!(
        sol_vault_balance >= pending_lamports,
        StakingError::InsufficientFunds
    );

    // Transfer exact pending amount from vault to user
    let pool_key = pool.key();
    let vault_seeds = &[
        b"sol_vault",
        pool_key.as_ref(),
        &[pool.sol_vault_bump],
    ];
    let signer_seeds = &[&vault_seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.sol_vault.to_account_info(),
            to: ctx.accounts.user.to_account_info(),
        },
        signer_seeds,
    );
    system_program::transfer(transfer_ctx, pending_lamports)?;

    // Update stake lot reward debt and last claimed timestamp
    stake_lot.reward_debt = accumulated;
    stake_lot.total_claimed = stake_lot.total_claimed
        .checked_add(pending_lamports)
        .ok_or(StakingError::MathOverflow)?;
    stake_lot.last_claimed_at = clock.unix_timestamp;

    // Update pool claimed total
    pool.total_rewards_claimed = pool.total_rewards_claimed
        .checked_add(pending_lamports)
        .ok_or(StakingError::MathOverflow)?;

    emit!(Claimed {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        lot: stake_lot.key(),
        amount: pending_lamports,
        timestamp: clock.unix_timestamp,
    });

    msg!("Claimed {} lamports in rewards", pending_lamports);
    
    Ok(())
}

/// Calculate pending rewards for a stake lot (view function helper)
/// 
/// Note: This is a view/estimation function. It uses unwrap_or(0) for underflow
/// because it may be called with stale data. Actual claim/unstake handlers
/// use fail-fast behavior (ok_or(MathOverflow)) to enforce invariants.
pub fn calculate_pending_rewards(
    stake_lot: &StakeLot,
    acc_sol_per_share: u128,
) -> Result<u64> {
    let accumulated = stake_lot.shares
        .checked_mul(acc_sol_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(SCALE)
        .ok_or(StakingError::MathOverflow)?;
    
    // View function: return 0 if underflow (stale data tolerance)
    // Transaction handlers use fail-fast for invariant enforcement
    let pending = accumulated
        .checked_sub(stake_lot.reward_debt)
        .unwrap_or(0);

    // Safe conversion from u128 to u64 with overflow check
    Ok(pending.try_into().map_err(|_| StakingError::MathOverflow)?)
}
