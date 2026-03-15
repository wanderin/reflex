use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::state::{Pool, ProtocolFeeConfig};
use crate::errors::StakingError;
use crate::events::ProtocolFeesCollected;

#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    /// Anyone can call — funds only go to the validated treasury
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"fee_config"],
        bump = fee_config.bump,
    )]
    pub fee_config: Box<Account<'info, ProtocolFeeConfig>>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// SOL vault PDA
    /// CHECK: Validated by seeds
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump = pool.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Treasury receives the fees
    /// CHECK: Validated against fee_config.treasury
    #[account(
        mut,
        constraint = treasury.key() == fee_config.treasury @ StakingError::TreasuryMismatch,
    )]
    pub treasury: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_collect_protocol_fees(ctx: Context<CollectProtocolFees>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let fee_config = &mut ctx.accounts.fee_config;
    let clock = Clock::get()?;

    let pending = pool.pending_protocol_fees();
    require!(pending > 0, StakingError::NoFeesToCollect);

    // Verify vault has sufficient balance
    let vault_balance = ctx.accounts.sol_vault.lamports();
    require!(vault_balance >= pending, StakingError::InsufficientFunds);

    // Transfer from sol_vault PDA to treasury
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
            to: ctx.accounts.treasury.to_account_info(),
        },
        signer_seeds,
    );
    system_program::transfer(transfer_ctx, pending)?;

    // Clear pending fees, update accounting
    pool.reserved[0] = 0; // pending_protocol_fees = 0

    // Critical: count collected fees as "claimed" to keep vault invariant correct:
    // expected = rent + total_rewards_funded - total_rewards_claimed
    pool.total_rewards_claimed = pool.total_rewards_claimed
        .checked_add(pending)
        .ok_or(StakingError::MathOverflow)?;

    fee_config.total_fees_collected = fee_config.total_fees_collected
        .checked_add(pending)
        .ok_or(StakingError::MathOverflow)?;

    emit!(ProtocolFeesCollected {
        pool: pool.key(),
        treasury: ctx.accounts.treasury.key(),
        amount: pending,
        timestamp: clock.unix_timestamp,
    });

    msg!("Collected {} lamports in protocol fees to treasury", pending);
    Ok(())
}
