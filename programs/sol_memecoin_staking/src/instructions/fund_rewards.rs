use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::state::{Pool, ProgramConfig};
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

    pub system_program: Program<'info, System>,
}

pub fn handler_fund_rewards(ctx: Context<FundRewards>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    require!(amount > 0, StakingError::InvalidAmount);

    // Require active stakers to prevent unallocated reward capture attack.
    // Without this, pre-funded rewards accumulate and the first staker + next
    // fund_rewards call captures the entire backlog.
    require!(pool.total_shares > 0, StakingError::NoStakers);

    // Transfer SOL from funder to vault
    let cpi_accounts = Transfer {
        from: ctx.accounts.funder.to_account_info(),
        to: ctx.accounts.sol_vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        cpi_accounts,
    );
    system_program::transfer(cpi_ctx, amount)?;

    // Calculate total amount to distribute (new funding + any unallocated rewards)
    let total_to_distribute = (amount as u128)
        .checked_add(pool.unallocated_rewards as u128)
        .ok_or(StakingError::MathOverflow)?;

    // Track how much was actually distributed to stakers
    let mut distributed_amount: u64 = 0;

    // Update acc_sol_per_share if there are shares
    if pool.total_shares > 0 {
        // acc_sol_per_share += (total_to_distribute * SCALE) / total_shares
        let amount_scaled = total_to_distribute
            .checked_mul(SCALE)
            .ok_or(StakingError::MathOverflow)?;
        
        let increase = amount_scaled
            .checked_div(pool.total_shares)
            .ok_or(StakingError::MathOverflow)?;
        
        pool.acc_sol_per_share = pool.acc_sol_per_share
            .checked_add(increase)
            .ok_or(StakingError::MathOverflow)?;

        distributed_amount = total_to_distribute
            .try_into()
            .map_err(|_| StakingError::MathOverflow)?;

        // Clear unallocated rewards since they've now been distributed
        if pool.unallocated_rewards > 0 {
            msg!(
                "Distributing {} previously unallocated lamports along with {} new lamports",
                pool.unallocated_rewards,
                amount
            );
            pool.unallocated_rewards = 0;
        }
    } else {
        // No stakers - add to unallocated rewards
        // These will be distributed on the next fund_rewards call when there are stakers
        pool.unallocated_rewards = pool.unallocated_rewards
            .checked_add(amount)
            .ok_or(StakingError::MathOverflow)?;
        
        msg!(
            "No stakers yet. {} lamports added to unallocated rewards (total: {})",
            amount,
            pool.unallocated_rewards
        );
    }

    pool.total_rewards_funded = pool.total_rewards_funded
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;

    emit!(RewardsFunded {
        pool: pool.key(),
        funder: ctx.accounts.funder.key(),
        amount,
        distributed_amount,
        new_acc_sol_per_share: pool.acc_sol_per_share,
        total_shares: pool.total_shares,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Funded {} lamports to pool. acc_sol_per_share: {}, total_shares: {}",
        amount,
        pool.acc_sol_per_share,
        pool.total_shares
    );
    
    Ok(())
}
