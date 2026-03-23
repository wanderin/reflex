use anchor_lang::prelude::*;

use crate::state::{Pool, ProtocolFeeConfig};
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

    /// Protocol fee config — required for fee enforcement.
    #[account(
        seeds = [b"fee_config"],
        bump = fee_config.bump,
    )]
    pub fee_config: Box<Account<'info, ProtocolFeeConfig>>,
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

    // Calculate protocol fee (stays in vault as pending, collected separately)
    // fee_config is required — callers cannot bypass fees
    let protocol_fee: u64 = if ctx.accounts.fee_config.reward_fee_bps > 0 && !pool.fee_exempt() {
        (new_rewards as u128)
            .checked_mul(ctx.accounts.fee_config.reward_fee_bps as u128)
            .ok_or(StakingError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(StakingError::MathOverflow)?
            .try_into()
            .map_err(|_| StakingError::MathOverflow)?
    } else {
        0
    };

    let net_rewards = new_rewards.checked_sub(protocol_fee).ok_or(StakingError::MathOverflow)?;

    if pool.total_shares > 0 {
        // Distribute net_rewards + any previously unallocated rewards
        let total_to_distribute = (net_rewards as u128)
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
                "sync_rewards: distributing {} unallocated + {} net new lamports",
                pool.unallocated_rewards,
                net_rewards
            );
            pool.unallocated_rewards = 0;
        }
    } else {
        // No stakers -- park net in unallocated_rewards for later distribution
        pool.unallocated_rewards = pool.unallocated_rewards
            .checked_add(net_rewards)
            .ok_or(StakingError::MathOverflow)?;

        msg!(
            "sync_rewards: no stakers, adding {} lamports to unallocated_rewards (total: {})",
            net_rewards,
            pool.unallocated_rewards
        );
    }

    // Accumulate pending fees in pool.reserved[0] and lifetime in pool.reserved[1]
    if protocol_fee > 0 {
        pool.reserved[0] = pool.reserved[0]
            .checked_add(protocol_fee)
            .ok_or(StakingError::MathOverflow)?;
        pool.reserved[1] = pool.reserved[1]
            .checked_add(protocol_fee)
            .ok_or(StakingError::MathOverflow)?;
    }

    // total_rewards_funded tracks FULL new_rewards (fee stays in vault until collection)
    pool.total_rewards_funded = pool.total_rewards_funded
        .checked_add(new_rewards)
        .ok_or(StakingError::MathOverflow)?;

    emit!(RewardsSynced {
        pool: pool.key(),
        syncer: ctx.accounts.payer.key(),
        new_rewards,
        protocol_fee,
        new_acc_sol_per_share: pool.acc_sol_per_share,
        total_shares: pool.total_shares,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "sync_rewards: synced {} lamports (fee: {}, net: {}) for pool {}",
        new_rewards,
        protocol_fee,
        net_rewards,
        pool.key(),
    );

    Ok(())
}
