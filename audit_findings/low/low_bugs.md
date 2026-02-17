## L-01 Defaulting to Permanent Stake for wrong Stakingtier passed in tier u8
Restricting the user's funds might be a good thing on paper / with the protocol but business wise it will raise a lot of concerns with users who because of some unknown error had their funds staked permamanently. this is caused by this code block here
```rust
 pub fn get_tier(&self) -> StakingTier {
        match self.tier {
            0 => StakingTier::Flexible,
            1 => StakingTier::Hours24,
            2 => StakingTier::Hours72,
            3 => StakingTier::Week1,
            4 => StakingTier::Month1,
            5 => StakingTier::Permanent,
            invalid => {
                msg!("WARNING: Invalid tier value {}, defaulting to Permanent", invalid);
                StakingTier::Permanent
            }
        }
    }
```
This always defaults to permanent for any value outside the 0-5 u8, a good code practice would be to revert with a descriptive error message.

## L-02 The arrangement of the multiplier in the pool init function is not monitored
In the [initialize_pool.rs](/programs/sol_memecoin_staking/src/instructions/initialize_pool.rs), the function `handler_initialize_pool()` has this block of code to initialize/set up multipliers for different lock times
```rust
 // Use provided multipliers or defaults
    let multipliers = tier_multipliers.unwrap_or(DEFAULT_TIER_MULTIPLIERS);
    
    // Validate multipliers - all must be >= 10000 (at least 1x) and <= 100000 (max 10x)
    for mult in multipliers.iter() {
        require!(*mult >= 10_000 && *mult <= MAX_TIER_MULTIPLIER, StakingError::InvalidMultipliers);
    }
```
This looks normal at first glance but when we go into the [lib.rs](/programs/sol_memecoin_staking/src/lib.rs) , the **DEFAULT_TIER_MULITPLIERS** with the comment above explaining tier bonus reward longer commitments by default
```rust
pub const DEFAULT_TIER_MULTIPLIERS: [u64; 6] = [
    10_000, // Flexible: 1.00x
    11_500, // 24 hours: 1.15x
    12_500, // 72 hours: 1.25x
    14_000, // 1 week: 1.40x
    17_000, // 1 month: 1.70x
    20_000, // Permanent: 2.00x
];
```
It is enforced here for the default but not for the code to set up the pool, this means any pool creator or config.authority can set up a buggy pool to let themselves or others game the multiplier system. 

I gave this a low severity, because it needs the help of the Admin or pool creator of both which are trusted entities, but we must be careful to enforce and verify not just trust alone. The impact can lead to a fast drop in price of the token due to scalpers or bot/script stakers going in and out every minute at multiple stakes per minute.
 Why this is a bug
  Staking protocols are generally designed to reward liquidity risk. The longer you lock your money, the higher your reward should be.
  By allowing a pool creator to set higher rewards for shorter durations, the protocol:
   1. Disincentivizes locking: Users will only use the Flexible tier because it pays the most and has zero risk.
   2. Enables "Flash Rewards": A creator could set a massive multiplier for Flexible, stake their own tokens, fund rewards, claim them
      immediately, and then unstake, essentially using the protocol to "wash" rewards to themselves with no lock-up period.
  **Recommendation**: The code should include a check to ensure that multipliers[i] <= multipliers[i+1] to enforce that longer locks always
  receive equal or greater rewards than shorter locks.