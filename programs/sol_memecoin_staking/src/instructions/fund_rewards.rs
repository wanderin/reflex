use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::state::{Pool, ProgramConfig, ProtocolFeeConfig};
use crate::errors::StakingError;
use crate::events::RewardsFunded;
use crate::SCALE;

#[derive(Accounts)]
pub struct FundRewards<'info> {
    /// The funder - can be global authority or creator wallet
    #[account(
        mut,
        constraint = (
            funder.key() == config.authority ||
            funder.key() == pool.creator_wallet
        ) @ StakingError::Unauthorized,
    )]
    pub funder: Signer<'info>,

    /// Program config
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    /// The pool to fund
    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// SOL vault PDA
    /// CHECK: PDA that holds SOL, validated by seeds
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump = pool.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Optional: protocol fee config. If absent, no fee is taken.
    /// Zero-downtime deploy: existing callers pass None until fee_config is initialized.
    #[account(
        seeds = [b"fee_config"],
        bump = fee_config.bump,
    )]
    pub fee_config: Option<Account<'info, ProtocolFeeConfig>>,

    /// Optional: treasury to receive fee (required if fee_config is provided)
    /// CHECK: Validated against fee_config.treasury if present
    #[account(mut)]
    pub treasury: Option<SystemAccount<'info>>,

    pub system_program: Program<'info, System>,
}

pub fn handler_fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    require!(amount > 0, StakingError::InvalidAmount);
    require!(pool.total_shares > 0, StakingError::NoStakers);

    // Calculate protocol fee (if fee_config present, fee > 0, and pool not exempt)
    let protocol_fee: u64 = match &ctx.accounts.fee_config {
        Some(fc) if fc.reward_fee_bps > 0 && !pool.fee_exempt() => {
            // Validate treasury matches
            let treasury = ctx.accounts.treasury.as_ref()
                .ok_or(StakingError::TreasuryMismatch)?;
            require!(treasury.key() == fc.treasury, StakingError::TreasuryMismatch);

            (amount as u128)
                .checked_mul(fc.reward_fee_bps as u128)
                .ok_or(StakingError::MathOverflow)?
                .checked_div(10_000)
                .ok_or(StakingError::MathOverflow)?
                .try_into()
                .map_err(|_| StakingError::MathOverflow)?
        }
        _ => 0,
    };

    let net_amount = amount.checked_sub(protocol_fee).ok_or(StakingError::MathOverflow)?;

    // Transfer net amount to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.funder.to_account_info(),
        to: ctx.accounts.sol_vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        cpi_accounts,
    );
    system_program::transfer(cpi_ctx, net_amount)?;

    // Transfer fee directly to treasury (fee never enters vault)
    if protocol_fee > 0 {
        let treasury = ctx.accounts.treasury.as_ref().unwrap();
        let fee_cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: treasury.to_account_info(),
            },
        );
        system_program::transfer(fee_cpi, protocol_fee)?;
    }

    // Distribute net_amount + any unallocated rewards
    let total_to_distribute = (net_amount as u128)
        .checked_add(pool.unallocated_rewards as u128)
        .ok_or(StakingError::MathOverflow)?;

    let amount_scaled = total_to_distribute
        .checked_mul(SCALE)
        .ok_or(StakingError::MathOverflow)?;

    let increase = amount_scaled
        .checked_div(pool.total_shares)
        .ok_or(StakingError::MathOverflow)?;

    pool.acc_sol_per_share = pool.acc_sol_per_share
        .checked_add(increase)
        .ok_or(StakingError::MathOverflow)?;

    let distributed_amount: u64 = total_to_distribute
        .try_into()
        .map_err(|_| StakingError::MathOverflow)?;

    if pool.unallocated_rewards > 0 {
        msg!(
            "Distributing {} previously unallocated lamports along with {} new lamports",
            pool.unallocated_rewards,
            net_amount
        );
        pool.unallocated_rewards = 0;
    }

    // Only count net amount as funded (fee was never in vault)
    pool.total_rewards_funded = pool.total_rewards_funded
        .checked_add(net_amount)
        .ok_or(StakingError::MathOverflow)?;

    emit!(RewardsFunded {
        pool: pool.key(),
        funder: ctx.accounts.funder.key(),
        amount,
        distributed_amount,
        protocol_fee,
        new_acc_sol_per_share: pool.acc_sol_per_share,
        total_shares: pool.total_shares,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Funded {} lamports (fee: {}, net: {}). acc_sol_per_share: {}, total_shares: {}",
        amount,
        protocol_fee,
        net_amount,
        pool.acc_sol_per_share,
        pool.total_shares
    );

    Ok(())
}
