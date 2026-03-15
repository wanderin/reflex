use anchor_lang::prelude::*;

#[error_code]
pub enum StakingError {
    #[msg("Invalid staking tier")]
    InvalidTier,

    #[msg("Cannot unstake before lock period ends")]
    UnstakeTooEarly,

    #[msg("Permanent tier stakes cannot be unstaked")]
    UnstakeNotAllowed,

    #[msg("Math overflow occurred")]
    MathOverflow,

    #[msg("Unauthorized - caller is not authorized")]
    Unauthorized,

    #[msg("Invalid amount - must be greater than zero")]
    InvalidAmount,

    #[msg("Stake lot is not active")]
    LotNotActive,

    #[msg("Invalid token program - must be SPL Token or Token-2022")]
    InvalidTokenProgram,

    #[msg("Token mint mismatch")]
    TokenMintMismatch,

    #[msg("Invalid tier multipliers - all must be >= 10000 and <= 100000")]
    InvalidMultipliers,

    #[msg("Insufficient funds in SOL vault")]
    InsufficientFunds,

    #[msg("No rewards to claim")]
    NoRewardsToClaim,

    #[msg("Invalid authority address")]
    InvalidWallet,

    #[msg("Caller must be the program upgrade authority")]
    NotUpgradeAuthority,

    #[msg("Token has unsupported extension (e.g., TransferFee, InterestBearing)")]
    UnsupportedTokenExtension,

    #[msg("Stake would result in zero shares - amount too small or multiplier issue")]
    ZeroShares,

    #[msg("New creator wallet is the same as current")]
    CreatorAlreadySet,

    #[msg("Cannot claim before minimum stake age (60 seconds)")]
    ClaimTooEarly,

    #[msg("Cannot fund rewards when pool has no stakers")]
    NoStakers,

    #[msg("Token mint has an active freeze authority")]
    FreezeAuthoritySet,

    #[msg("Cannot merge lots with different tiers")]
    TierMismatch,

    #[msg("Cannot transfer a stake lot to yourself")]
    SelfTransferNotAllowed,

    #[msg("Custom lock duration too short (minimum 60 seconds)")]
    CustomLockTooShort,

    #[msg("Use Permanent tier for permanent locks, not Custom")]
    CustomLockPermanentNotAllowed,

    #[msg("Custom tier does not support add_to_lot or merge_lots")]
    CustomTierNotSupported,

    #[msg("Fee exceeds maximum allowed (10%)")]
    FeeTooHigh,

    #[msg("Treasury address cannot be default/zero")]
    InvalidTreasury,

    #[msg("No protocol fees pending for collection")]
    NoFeesToCollect,

    #[msg("Treasury account does not match fee config")]
    TreasuryMismatch,
}
