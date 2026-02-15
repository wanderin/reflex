use anchor_lang::prelude::*;

use crate::state::ProgramConfig;
use crate::errors::StakingError;
use crate::events::{ConfigInitialized, AuthorityUpdated, PoolCreatorUpdated};
use crate::ID;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    /// The initial authority (becomes the program authority)
    /// Must be the program's upgrade authority for security
    #[account(mut)]
    pub authority: Signer<'info>,

    /// The config PDA
    #[account(
        init,
        payer = authority,
        space = ProgramConfig::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// The program's executable account
    /// CHECK: Validated to be our program
    #[account(
        constraint = program.key() == ID @ StakingError::Unauthorized,
        executable,
    )]
    pub program: UncheckedAccount<'info>,

    /// The program data account containing upgrade authority
    /// CHECK: Validated by seed derivation from program
    #[account(
        constraint = program_data.key() == get_program_data_address(&program.key()) @ StakingError::Unauthorized,
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Get the program data address for a given program ID
fn get_program_data_address(program_id: &Pubkey) -> Pubkey {
    let (program_data, _bump) = Pubkey::find_program_address(
        &[program_id.as_ref()],
        &anchor_lang::solana_program::bpf_loader_upgradeable::id(),
    );
    program_data
}

/// Initialize the program config. Can only be called once.
/// Caller must be the program's upgrade authority.
pub fn handler_initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
    // Verify the signer is the upgrade authority
    let program_data_info = ctx.accounts.program_data.to_account_info();
    let program_data = program_data_info.try_borrow_data()?;
    
    // ProgramData is serialized as UpgradeableLoaderState enum (ProgramData variant):
    // - 4 bytes: enum discriminant (value 3 for ProgramData, little-endian)
    // - 8 bytes: slot (u64) - slot at which program was last deployed/upgraded
    // - 1 byte: Option discriminator for upgrade_authority (0 = None, 1 = Some)
    // - 32 bytes: upgrade_authority pubkey (if Some)
    // 
    // Total layout: 4 + 8 + 1 + 32 = 45 bytes minimum
    // Enum discriminant at bytes 0-3, option discriminator at byte 12, pubkey at bytes 13-45
    
    require!(program_data.len() >= 45, StakingError::Unauthorized);
    
    // Verify this is actually a ProgramData account (discriminant == 3)
    // UpgradeableLoaderState enum: Uninitialized=0, Buffer=1, Program=2, ProgramData=3
    let discriminant = u32::from_le_bytes([
        program_data[0], program_data[1], program_data[2], program_data[3]
    ]);
    require!(discriminant == 3, StakingError::Unauthorized);
    
    // Check if upgrade authority is set (not None) - option discriminator at byte 12
    let has_authority = program_data[12] == 1;
    require!(has_authority, StakingError::NotUpgradeAuthority);
    
    // Extract upgrade authority pubkey (bytes 13-45)
    let upgrade_authority = Pubkey::try_from(&program_data[13..45])
        .map_err(|_| StakingError::Unauthorized)?;
    
    // Verify signer is the upgrade authority
    require!(
        ctx.accounts.authority.key() == upgrade_authority,
        StakingError::NotUpgradeAuthority
    );

    let config = &mut ctx.accounts.config;
    let clock = Clock::get()?;

    config.authority = ctx.accounts.authority.key();
    config.bump = ctx.bumps.config;
    config.pool_creator = Pubkey::default();

    emit!(ConfigInitialized {
        config: config.key(),
        authority: config.authority,
        timestamp: clock.unix_timestamp,
    });

    msg!("Program config initialized. Authority: {} (verified as upgrade authority)", config.authority);
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateAuthority<'info> {
    /// The current authority
    #[account(
        constraint = authority.key() == config.authority @ StakingError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    /// The config PDA
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,

    /// The program's executable account
    /// CHECK: Validated to be our program
    #[account(
        constraint = program.key() == ID @ StakingError::Unauthorized,
        executable,
    )]
    pub program: UncheckedAccount<'info>,

    /// The program data account containing upgrade authority
    /// CHECK: Validated by seed derivation from program
    #[account(
        constraint = program_data.key() == get_program_data_address(&program.key()) @ StakingError::Unauthorized,
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Update the program authority. Only current authority can call.
/// new_authority must match the current program upgrade authority.
/// 
/// Workflow: First transfer upgrade authority via `solana program set-upgrade-authority`,
/// then call this to sync config.authority.
pub fn handler_update_authority(
    ctx: Context<UpdateAuthority>,
    new_authority: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let clock = Clock::get()?;

    require!(new_authority != Pubkey::default(), StakingError::InvalidWallet);

    // Verify new_authority matches the current program upgrade authority
    let program_data_info = ctx.accounts.program_data.to_account_info();
    let program_data = program_data_info.try_borrow_data()?;
    
    require!(program_data.len() >= 45, StakingError::Unauthorized);
    
    // Verify ProgramData discriminant
    let discriminant = u32::from_le_bytes([
        program_data[0], program_data[1], program_data[2], program_data[3]
    ]);
    require!(discriminant == 3, StakingError::Unauthorized);
    
    // Verify upgrade authority is set
    require!(program_data[12] == 1, StakingError::NotUpgradeAuthority);
    
    // Extract upgrade authority pubkey
    let upgrade_authority = Pubkey::try_from(&program_data[13..45])
        .map_err(|_| StakingError::Unauthorized)?;
    
    // new_authority must be the upgrade authority
    require!(
        new_authority == upgrade_authority,
        StakingError::NotUpgradeAuthority
    );

    let old_authority = config.authority;
    config.authority = new_authority;

    emit!(AuthorityUpdated {
        config: config.key(),
        old_authority,
        new_authority,
        timestamp: clock.unix_timestamp,
    });

    msg!("Authority updated from {} to {} (verified as upgrade authority)", old_authority, new_authority);
    Ok(())
}

#[derive(Accounts)]
pub struct SetPoolCreator<'info> {
    /// The current authority - only authority can set pool_creator
    #[account(
        constraint = authority.key() == config.authority @ StakingError::Unauthorized,
    )]
    pub authority: Signer<'info>,

    /// The config PDA
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProgramConfig>,
}

/// Set or update the pool_creator role.
/// Only the global authority can call this.
/// The pool_creator can only create pools - no other admin powers.
///
/// # Arguments
/// * `new_pool_creator` - The new pool creator pubkey (Pubkey::default() to disable)
pub fn handler_set_pool_creator(
    ctx: Context<SetPoolCreator>,
    new_pool_creator: Pubkey,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let clock = Clock::get()?;

    let old_pool_creator = config.pool_creator;
    config.pool_creator = new_pool_creator;

    emit!(PoolCreatorUpdated {
        config: config.key(),
        old_pool_creator,
        new_pool_creator,
        timestamp: clock.unix_timestamp,
    });

    msg!("Pool creator updated from {} to {}", old_pool_creator, new_pool_creator);
    Ok(())
}
