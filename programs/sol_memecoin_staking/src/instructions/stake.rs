use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::Staked;
use crate::{StakingTier, MIN_CUSTOM_LOCK_SECONDS};

#[derive(Accounts)]
#[instruction(amount: u64, tier: StakingTier, lot_seed: u64)]
pub struct Stake<'info> {
    /// The user staking tokens
    #[account(mut)]
    pub user: Signer<'info>,

    /// The pool to stake into
    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// The stake lot PDA for this stake position
    #[account(
        init,
        payer = user,
        space = StakeLot::LEN,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), lot_seed.to_le_bytes().as_ref()],
        bump,
    )]
    pub stake_lot: Box<Account<'info, StakeLot>>,

    /// User's token account
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_token_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token vault PDA
    #[account(
        mut,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump = pool.token_vault_bump,
        token::mint = token_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Token mint
    #[account(
        address = pool.token_mint @ StakingError::TokenMintMismatch,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Token program
    #[account(
        address = pool.token_program @ StakingError::InvalidTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,

    pub system_program: Program<'info, System>,
}

pub fn handler_stake(
    ctx: Context<Stake>,
    amount: u64,
    tier: StakingTier,
    lot_seed: u64,
    custom_unlock_at: Option<i64>,
) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let stake_lot = &mut ctx.accounts.stake_lot;
    let clock = Clock::get()?;

    // Validate amount (no minimum with linear scaling - rent cost deters spam)
    require!(amount > 0, StakingError::InvalidAmount);

    // Calculate shares for this stake (returns MathOverflow on overflow)
    let shares = pool.calculate_shares(amount, &tier)?;

    // Reject stakes that would result in zero shares (prevents broken lots)
    require!(shares > 0, StakingError::ZeroShares);

    // Calculate reward debt (debt = shares * acc_sol_per_share / SCALE)
    let reward_debt = shares
        .checked_mul(pool.acc_sol_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(crate::SCALE)
        .ok_or(StakingError::MathOverflow)?;

    // Calculate unlock time based on tier
    let unlock_at = if tier == StakingTier::Custom {
        // Custom tier: user provides their own unlock timestamp
        let user_unlock = custom_unlock_at.ok_or(StakingError::CustomLockTooShort)?;
        // Minimum 60 seconds from now (anti-sandwich)
        require!(
            user_unlock >= clock.unix_timestamp + MIN_CUSTOM_LOCK_SECONDS,
            StakingError::CustomLockTooShort
        );
        // Must not be permanent — use Permanent tier for that
        require!(
            user_unlock < i64::MAX,
            StakingError::CustomLockPermanentNotAllowed
        );
        user_unlock
    } else if tier == StakingTier::Permanent {
        i64::MAX
    } else {
        let lock_duration = tier.lock_duration_seconds();
        clock.unix_timestamp
            .checked_add(lock_duration as i64)
            .ok_or(StakingError::MathOverflow)?
    };

    // Initialize stake lot
    stake_lot.pool = pool.key();
    stake_lot.owner = ctx.accounts.user.key();
    stake_lot.lot_seed = lot_seed;
    stake_lot.bump = ctx.bumps.stake_lot;
    stake_lot.tier = tier.index() as u8;
    stake_lot.amount = amount;
    stake_lot.shares = shares;
    stake_lot.staked_at = clock.unix_timestamp;
    stake_lot.unlock_at = unlock_at;
    stake_lot.reward_debt = reward_debt;
    stake_lot.total_claimed = 0;
    stake_lot.active = true;
    stake_lot.last_claimed_at = clock.unix_timestamp; // Initialize to stake time
    stake_lot.reserved = [0; 3];

    // Update pool state
    pool.total_shares = pool.total_shares
        .checked_add(shares)
        .ok_or(StakingError::MathOverflow)?;
    pool.total_staked = pool.total_staked
        .checked_add(amount)
        .ok_or(StakingError::MathOverflow)?;
    pool.active_lots = pool.active_lots
        .checked_add(1)
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

    emit!(Staked {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        lot: stake_lot.key(),
        amount,
        shares,
        tier: tier.index() as u8,
        unlock_at,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Staked {} tokens with tier {:?}, shares: {}, unlock_at: {}",
        amount,
        tier,
        shares,
        unlock_at
    );

    Ok(())
}
