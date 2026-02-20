use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, StateWithExtensions, ExtensionType},
};
use crate::state::{Pool, ProgramConfig};
use crate::errors::StakingError;
use crate::events::PoolInitialized;
use crate::DEFAULT_TIER_MULTIPLIERS;

/// Maximum tier multiplier (10x = 100,000 basis points)
pub const MAX_TIER_MULTIPLIER: u64 = 100_000;

/// Base mint size (without extensions)
const MINT_SIZE: usize = 82;

#[derive(Accounts)]
#[instruction(creator_wallet: Pubkey)]
pub struct InitializePool<'info> {
    /// The pool creator -- anyone can create a pool (permissionless)
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Program config -- kept in accounts for backward compatibility
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProgramConfig>>,

    /// The token mint for staking
    #[account(
        mint::token_program = token_program,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The pool PDA
    #[account(
        init,
        payer = authority,
        space = Pool::LEN,
        seeds = [b"pool", token_mint.key().as_ref()],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,

    /// Token vault PDA - holds staked tokens
    #[account(
        init,
        payer = authority,
        seeds = [b"token_vault", pool.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// SOL vault PDA - holds reward SOL
    /// CHECK: This is a PDA that will be created to hold SOL rewards
    #[account(
        mut,
        seeds = [b"sol_vault", pool.key().as_ref()],
        bump,
    )]
    pub sol_vault: UncheckedAccount<'info>,

    /// Token program - must be SPL Token or Token-2022
    #[account(
        constraint = (
            token_program.key() == spl_token_2022::ID ||
            token_program.key() == anchor_spl::token::ID
        ) @ StakingError::InvalidTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,
    
    pub system_program: Program<'info, System>,
}

/// Check if a mint has any dangerous Token-2022 extensions that would break accounting.
/// For old SPL Token mints (82 bytes, no extensions possible), this is a safe no-op.
/// For Token-2022 mints, blocks: TransferFeeConfig, InterestBearingConfig,
/// PermanentDelegate, TransferHook, ConfidentialTransferMint, NonTransferable.
fn validate_mint_extensions(mint_account_info: &AccountInfo) -> Result<()> {
    let mint_data = mint_account_info.try_borrow_data()?;
    
    // If the mint data is exactly 82 bytes, it has no extensions.
    // This covers both old SPL Token mints (always 82 bytes) and base Token-2022
    // mints without extensions. Both are safe — no dangerous extensions can exist.
    if mint_data.len() == MINT_SIZE {
        return Ok(());
    }
    
    // Parse the mint with extensions
    let mint_with_extensions = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
        .map_err(|_| StakingError::UnsupportedTokenExtension)?;
    
    // List of dangerous extensions that break accounting or transfers
    let dangerous_extensions = [
        ExtensionType::TransferFeeConfig,
        ExtensionType::InterestBearingConfig,
        ExtensionType::PermanentDelegate,
        ExtensionType::TransferHook,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::ConfidentialTransferFeeConfig,
        ExtensionType::NonTransferable,  // Would block all transfers
    ];
    
    // Get the list of extension types on this mint
    let extension_types = mint_with_extensions.get_extension_types()
        .map_err(|_| StakingError::UnsupportedTokenExtension)?;
    
    // Check if any dangerous extension is present
    for ext_type in extension_types.iter() {
        if dangerous_extensions.contains(ext_type) {
            msg!("Token has unsupported extension: {:?}", ext_type);
            return Err(StakingError::UnsupportedTokenExtension.into());
        }
    }
    
    msg!("Mint extensions validated. Found {} extensions, all safe.", extension_types.len());
    Ok(())
}

pub fn handler_initialize_pool(
    ctx: Context<InitializePool>,
    creator_wallet: Pubkey,
    tier_multipliers: Option<[u64; 6]>,
) -> Result<()> {
    // Validate that the mint doesn't have dangerous extensions
    validate_mint_extensions(&ctx.accounts.token_mint.to_account_info())?;

    // Block mints with an active freeze authority -- a freeze authority holder
    // could freeze the token vault PDA, permanently trapping staker tokens.
    require!(
        ctx.accounts.token_mint.freeze_authority.is_none(),
        StakingError::FreezeAuthoritySet
    );

    let pool = &mut ctx.accounts.pool;
    let clock = Clock::get()?;

    // Use provided multipliers or defaults
    let multipliers = tier_multipliers.unwrap_or(DEFAULT_TIER_MULTIPLIERS);
    
    // Validate multipliers - all must be >= 10000 (at least 1x) and <= 100000 (max 10x)
    for mult in multipliers.iter() {
        require!(*mult >= 10_000 && *mult <= MAX_TIER_MULTIPLIER, StakingError::InvalidMultipliers);
    }

    // Store bumps before creating sol_vault (pool will be borrowed)
    let pool_bump = ctx.bumps.pool;
    let token_vault_bump = ctx.bumps.token_vault;
    let sol_vault_bump = ctx.bumps.sol_vault;

    // Create or fund the SOL vault PDA
    // This is a system-owned account that just holds lamports
    let rent = Rent::get()?;
    let required_lamports = rent.minimum_balance(0);
    let current_lamports = ctx.accounts.sol_vault.lamports();

    if current_lamports == 0 {
        // Account doesn't exist, create it
        let pool_key = pool.key();
        let sol_vault_seeds = &[
            b"sol_vault",
            pool_key.as_ref(),
            &[sol_vault_bump],
        ];
        let signer_seeds = &[&sol_vault_seeds[..]];

        let create_account_ctx = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.authority.to_account_info(),
                to: ctx.accounts.sol_vault.to_account_info(),
            },
            signer_seeds,
        );
        system_program::create_account(
            create_account_ctx,
            required_lamports,
            0, // 0 bytes of data
            &system_program::ID, // Owner is System Program
        )?;
    } else {
        // Account exists (pre-funded?), verify ownership and top up if needed
        require!(
            *ctx.accounts.sol_vault.owner == system_program::ID,
            StakingError::Unauthorized
        );

        if current_lamports < required_lamports {
            let diff = required_lamports - current_lamports;
            let transfer_ctx = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.sol_vault.to_account_info(),
                },
            );
            system_program::transfer(transfer_ctx, diff)?;
        }
    }

    // Initialize pool state
    pool.token_mint = ctx.accounts.token_mint.key();
    pool.token_program = ctx.accounts.token_program.key();
    pool.bump = pool_bump;
    pool.token_vault_bump = token_vault_bump;
    pool.sol_vault_bump = sol_vault_bump;
    pool._padding = 0;
    pool.total_shares = 0;
    pool.acc_sol_per_share = 0;
    pool.total_rewards_funded = 0;
    pool.total_rewards_claimed = 0;
    pool.unallocated_rewards = 0;
    pool.tier_multipliers = multipliers;
    pool.active_lots = 0;
    pool.total_staked = 0;
    pool.created_at = clock.unix_timestamp;
    pool.creator_wallet = creator_wallet;
    pool.reserved = [0; 4];

    emit!(PoolInitialized {
        pool: pool.key(),
        token_mint: pool.token_mint,
        creator_wallet: pool.creator_wallet,
        tier_multipliers: pool.tier_multipliers,
        timestamp: clock.unix_timestamp,
    });

    msg!("Pool initialized for mint: {} (creator: {})", pool.token_mint, creator_wallet);
    Ok(())
}
