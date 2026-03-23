use anchor_lang::prelude::*;

use crate::state::{Pool, ProgramConfig, ProtocolFeeConfig};
use crate::errors::StakingError;
use crate::events::{FeeConfigInitialized, FeeConfigUpdated, PoolConfigUpdated};
use crate::{MAX_REWARD_FEE_BPS, ID};

// ── helpers ──────────────────────────────────────────────────────────────────

fn get_program_data_address(program_id: &Pubkey) -> Pubkey {
    let (addr, _) = Pubkey::find_program_address(
        &[program_id.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    );
    addr
}

/// Extract the upgrade authority from the on-chain ProgramData account.
/// Returns `None` if the authority is not set.
fn extract_upgrade_authority(program_data: &AccountInfo) -> Result<Option<Pubkey>> {
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45, StakingError::Unauthorized);
    let discriminant = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    require!(discriminant == 3, StakingError::Unauthorized);
    if data[12] != 1 {
        return Ok(None);
    }
    let key = Pubkey::try_from(&data[13..45]).map_err(|_| StakingError::Unauthorized)?;
    Ok(Some(key))
}

/// Require signer is either config.authority or upgrade authority.
fn require_authority_or_upgrade(
    signer: &Pubkey,
    config_authority: &Pubkey,
    program_data: &AccountInfo,
) -> Result<()> {
    if signer == config_authority {
        return Ok(());
    }
    let upgrade_auth = extract_upgrade_authority(program_data)?
        .ok_or(StakingError::NotUpgradeAuthority)?;
    require!(signer == &upgrade_auth, StakingError::Unauthorized);
    Ok(())
}

// ── InitializeFeeConfig ──────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeFeeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    #[account(
        init,
        payer = authority,
        space = ProtocolFeeConfig::LEN,
        seeds = [b"fee_config"],
        bump,
    )]
    pub fee_config: Box<Account<'info, ProtocolFeeConfig>>,

    /// CHECK: Validated to be our program
    #[account(
        constraint = program.key() == ID @ StakingError::Unauthorized,
        executable,
    )]
    pub program: UncheckedAccount<'info>,

    /// CHECK: Validated by seed derivation from program
    #[account(
        constraint = program_data.key() == get_program_data_address(&program.key()) @ StakingError::Unauthorized,
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler_initialize_fee_config(
    ctx: Context<InitializeFeeConfig>,
    treasury: Pubkey,
    reward_fee_bps: u16,
) -> Result<()> {
    require_authority_or_upgrade(
        &ctx.accounts.authority.key(),
        &ctx.accounts.config.authority,
        &ctx.accounts.program_data.to_account_info(),
    )?;

    require!(treasury != Pubkey::default(), StakingError::InvalidTreasury);
    require!(reward_fee_bps <= MAX_REWARD_FEE_BPS, StakingError::FeeTooHigh);

    let fee_config = &mut ctx.accounts.fee_config;
    let clock = Clock::get()?;

    fee_config.authority = ctx.accounts.config.authority;
    fee_config.bump = ctx.bumps.fee_config;
    fee_config.treasury = treasury;
    fee_config.reward_fee_bps = reward_fee_bps;
    fee_config.pool_creation_fee = 0;
    fee_config.total_fees_collected = 0;
    fee_config.reserved = [0; 4];

    emit!(FeeConfigInitialized {
        fee_config: fee_config.key(),
        authority: fee_config.authority,
        treasury,
        reward_fee_bps,
        timestamp: clock.unix_timestamp,
    });

    msg!("Fee config initialized: treasury={}, fee_bps={}", treasury, reward_fee_bps);
    Ok(())
}

// ── UpdateFeeConfig ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct UpdateFeeConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    #[account(
        mut,
        seeds = [b"fee_config"],
        bump = fee_config.bump,
    )]
    pub fee_config: Box<Account<'info, ProtocolFeeConfig>>,

    /// CHECK: Validated to be our program
    #[account(
        constraint = program.key() == ID @ StakingError::Unauthorized,
        executable,
    )]
    pub program: UncheckedAccount<'info>,

    /// CHECK: Validated by seed derivation
    #[account(
        constraint = program_data.key() == get_program_data_address(&program.key()) @ StakingError::Unauthorized,
    )]
    pub program_data: UncheckedAccount<'info>,
}

pub fn handler_update_fee_config(
    ctx: Context<UpdateFeeConfig>,
    treasury: Pubkey,
    reward_fee_bps: u16,
) -> Result<()> {
    require_authority_or_upgrade(
        &ctx.accounts.authority.key(),
        &ctx.accounts.config.authority,
        &ctx.accounts.program_data.to_account_info(),
    )?;

    require!(treasury != Pubkey::default(), StakingError::InvalidTreasury);
    require!(reward_fee_bps <= MAX_REWARD_FEE_BPS, StakingError::FeeTooHigh);

    let fee_config = &mut ctx.accounts.fee_config;
    let clock = Clock::get()?;

    fee_config.treasury = treasury;
    fee_config.reward_fee_bps = reward_fee_bps;

    emit!(FeeConfigUpdated {
        fee_config: fee_config.key(),
        treasury,
        reward_fee_bps,
        timestamp: clock.unix_timestamp,
    });

    msg!("Fee config updated: treasury={}, fee_bps={}", treasury, reward_fee_bps);
    Ok(())
}

// ── SetPoolConfig ────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct SetPoolConfig<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    #[account(
        mut,
        seeds = [b"pool", pool.token_mint.as_ref()],
        bump = pool.bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// CHECK: Validated to be our program
    #[account(
        constraint = program.key() == ID @ StakingError::Unauthorized,
        executable,
    )]
    pub program: UncheckedAccount<'info>,

    /// CHECK: Validated by seed derivation
    #[account(
        constraint = program_data.key() == get_program_data_address(&program.key()) @ StakingError::Unauthorized,
    )]
    pub program_data: UncheckedAccount<'info>,
}

pub fn handler_set_pool_config(
    ctx: Context<SetPoolConfig>,
    fee_exempt: Option<u8>,
    custom_multiplier_bps: Option<u64>,
) -> Result<()> {
    require_authority_or_upgrade(
        &ctx.accounts.authority.key(),
        &ctx.accounts.config.authority,
        &ctx.accounts.program_data.to_account_info(),
    )?;

    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    if let Some(exempt) = fee_exempt {
        require!(exempt == 0 || exempt == 1, StakingError::InvalidFeeExempt);
        pool._padding = exempt;
    }

    if let Some(mult) = custom_multiplier_bps {
        // Validate: 0 to disable, or >= 10000 (at least 1.0x) and <= 100000 (max 10x)
        require!(
            mult == 0 || (mult >= 10_000 && mult <= 100_000),
            StakingError::InvalidMultipliers
        );
        pool.reserved[2] = mult;
    }

    emit!(PoolConfigUpdated {
        pool: pool.key(),
        fee_exempt: pool._padding,
        custom_multiplier_bps: pool.reserved[2],
        timestamp: clock.unix_timestamp,
    });

    msg!(
        "Pool config updated: fee_exempt={}, custom_multiplier_bps={}",
        pool._padding,
        pool.reserved[2]
    );
    Ok(())
}
