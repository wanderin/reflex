use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::state::{Pool, StakeLot};
use crate::errors::StakingError;
use crate::events::Unstaked;
use crate::SCALE;

#[derive(Accounts)]
pub struct Unstake<'info> {
    /// The user unstaking tokens
    #[account(mut)]
    pub user: Signer<'info>,

    /// The pool
    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    /// The stake lot to unstake from - closed after unstake to return rent
    #[account(
        mut,
        seeds = [b"lot", pool.key().as_ref(), user.key().as_ref(), stake_lot.lot_seed.to_le_bytes().as_ref()],
        bump = stake_lot.bump,
        has_one = pool,
        constraint = stake_lot.owner == user.key() @ StakingError::Unauthorized,
        constraint = stake_lot.active @ StakingError::LotNotActive,
        close = user,
    )]
    pub stake_lot: Account<'info, StakeLot>,

    /// User's token account
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token vault PDA
    #[account(
        mut,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump = pool.token_vault_bump,
        token::mint = token_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    /// Token mint
    #[account(
        address = pool.token_mint @ StakingError::TokenMintMismatch,
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// SOL vault PDA
    /// CHECK: PDA that holds SOL, validated by seeds
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump = pool.sol_vault_bump,
    )]
    pub sol_vault: SystemAccount<'info>,

    /// Token program
    #[account(
        address = pool.token_program @ StakingError::InvalidTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,
    
    pub system_program: Program<'info, System>,
}

pub fn handler_unstake(ctx: Context<Unstake>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let stake_lot = &mut ctx.accounts.stake_lot;
    let clock = Clock::get()?;

    // Check if permanent tier (cannot unstake)
    require!(stake_lot.tier != 5, StakingError::UnstakeNotAllowed);

    // Check if lock period has passed
    require!(
        stake_lot.can_unstake(clock.unix_timestamp),
        StakingError::UnstakeTooEarly
    );

    let amount = stake_lot.amount;
    let shares = stake_lot.shares;

    // Track rewards transferred
    let mut rewards_transferred: u64 = 0;

    // Calculate and transfer pending rewards
    let accumulated = stake_lot.shares
        .checked_mul(pool.acc_sol_per_share)
        .ok_or(StakingError::MathOverflow)?
        .checked_div(SCALE)
        .ok_or(StakingError::MathOverflow)?;
    
    let pending = accumulated
        .checked_sub(stake_lot.reward_debt)
        .ok_or(StakingError::MathOverflow)?;

    let pending_lamports: u64 = pending
        .try_into()
        .map_err(|_| StakingError::MathOverflow)?;

    if pending_lamports > 0 {
        // Check SOL vault has sufficient funds
        let sol_vault_balance = ctx.accounts.sol_vault.lamports();
        require!(
            sol_vault_balance >= pending_lamports,
            StakingError::InsufficientFunds
        );
        
        // Use invoke_signed for safe PDA transfer
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

        rewards_transferred = pending_lamports;

        pool.total_rewards_claimed = pool.total_rewards_claimed
            .checked_add(pending_lamports)
            .ok_or(StakingError::MathOverflow)?;
    }

    // Transfer tokens back to user
    let token_mint_key = pool.token_mint;
    let pool_seeds = &[
        b"pool",
        token_mint_key.as_ref(),
        &[pool.bump],
    ];
    let signer_seeds = &[&pool_seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.token_vault.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: pool.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
    
    token_interface::transfer_checked(
        cpi_ctx,
        amount,
        ctx.accounts.token_mint.decimals,
    )?;

    // Update pool state
    pool.total_shares = pool.total_shares
        .checked_sub(shares)
        .ok_or(StakingError::MathOverflow)?;
    pool.total_staked = pool.total_staked
        .checked_sub(amount)
        .ok_or(StakingError::MathOverflow)?;
    pool.active_lots = pool.active_lots
        .checked_sub(1)
        .ok_or(StakingError::MathOverflow)?;

    // Note: stake_lot account is closed via `close = user` constraint
    // Rent (~0.002 SOL) is returned to the user

    // Emit event with ACTUAL rewards transferred, not pending
    emit!(Unstaked {
        pool: pool.key(),
        user: ctx.accounts.user.key(),
        lot: stake_lot.key(),
        amount,
        shares_removed: shares,
        rewards_claimed: rewards_transferred,
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Unstaked {} tokens, claimed {} lamports in rewards",
        amount,
        rewards_transferred
    );
    
    Ok(())
}
