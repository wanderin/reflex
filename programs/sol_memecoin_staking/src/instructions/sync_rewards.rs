use anchor_lang::prelude::*;

use crate::state::Pool;
use crate::errors::StakingError;
use crate::events::RewardsSynced;
use crate::SCALE;

#[derive(Accounts)]
pub struct SyncRewards<'info> {
    /// Anyone can call this -- just pays the transaction fee
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// SOL vault PDA -- holds reward SOL
    /// CHECK: Validated by seeds against the pool
    #[account(
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump = pool.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,
}

pub fn handler_sync_rewards(ctx: Context<SyncRewards>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    let rent = Rent::get()?;
    let rent_exempt = rent.minimum_balance(0);

    let vault_balance = ctx.accounts.sol_vault.lamports();

    // expected = rent_exempt + total_rewards_funded - total_rewards_claimed
    let expected_balance = (rent_exempt as u128)
        .checked_add(pool.total_rewards_funded as u128)
        .ok_or(StakingError::MathOverflow)?
        .checked_sub(pool.total_rewards_claimed as u128)
        .ok_or(StakingError::MathOverflow)?;

    if (vault_balance as u128) <= expected_balance {
        msg!("sync_rewards: no new SOL detected, nothing to sync");
        return Ok(());
    }

    let new_rewards_u128 = (vault_balance as u128)
        .checked_sub(expected_balance)
        .ok_or(StakingError::MathOverflow)?;

    let new_rewards: u64 = new_rewards_u128
        .try_into()
        .map_err(|_| StakingError::MathOverflow)?;

    if pool.total_shares > 0 {
        // Include any previously unallocated rewards
        let total_to_distribute = (new_rewards as u128)
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

        if pool.unallocated_rewards > 0 {
            msg!(
                "sync_rewards: distributing {} unallocated + {} new lamports",
                pool.unallocated_rewards,
                new_rewards
            );
            pool.unallocated_rewards = 0;
        }
    } else {
        // No stakers -- park in unallocated_rewards for later distribution
        pool.unallocated_rewards = pool.unallocated_rewards
            .checked_add(new_rewards)
            .ok_or(StakingError::MathOverflow)?;

        msg!(
            "sync_rewards: no stakers, adding {} lamports to unallocated_rewards (total: {})",
            new_rewards,
            pool.unallocated_rewards
        );
    }

    pool.total_rewards_funded = pool.total_rewards_funded
        .checked_add(new_rewards)
        .ok_or(StakingError::MathOverflow)?;

    emit!(RewardsSynced {
        pool: pool.key(),
        syncer: ctx.accounts.payer.key(),
        new_rewards,
        new_acc_sol_per_share: pool.acc_sol_per_share,
        total_shares: pool.total_shares,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "sync_rewards: synced {} lamports for pool {}. acc_sol_per_share: {}, total_shares: {}",
        new_rewards,
        pool.key(),
        pool.acc_sol_per_share,
        pool.total_shares
    );

    Ok(())
}
