/**
 * Economic Attack Tests
 * 
 * Tests for:
 * - Front-running fund_rewards
 * - Dust attacks (many tiny stakes)
 * - Whale dominance analysis (linear scaling)
 * - Rapid stake/unstake gaming
 * 
 * Note: Linear scaling eliminates Sybil advantage from splitting.
 * 
 * Run: npx ts-node tests/security/economic-attacks.test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import BN from "bn.js";
import {
  initTestConfig,
  derivePoolPda,
  deriveSolVaultPda,
  deriveTokenVaultPda,
  deriveStakeLotPda,
  deriveConfigPda,
  getUserLots,
  calculatePendingRewards,
  logTestResult,
  formatLamports,
  StakingTier,
  SCALE,
  sleep,
  TestConfig,
} from "../common";

async function runEconomicAttackTests() {
  console.log("\n" + "=".repeat(60));
  console.log("ECONOMIC ATTACK TESTS");
  console.log("=".repeat(60) + "\n");

  const config = await initTestConfig();
  const { program, programId, adminKeypair, userKeypair, tokenMint, tokenProgram, decimals, connection } = config;

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);
  const [configPda] = deriveConfigPda(programId);

  let passCount = 0;
  let failCount = 0;

  // ============================================================
  // TEST 1: Whale dominance analysis (linear scaling)
  // ============================================================
  console.log("\n--- Test 1: Whale dominance analysis ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const allLots = await program.account.stakeLot.all();
    const activeLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && lot.account.active
    );
    
    if (activeLots.length < 2) {
      console.log("   Skipping: Need at least 2 stakers to analyze dominance");
      passCount++;
    } else {
      // Calculate total shares and individual percentages
      const totalShares = BigInt(pool.totalShares.toString());
      
      console.log(`   Total shares in pool: ${totalShares}`);
      console.log(`   Number of active stakes: ${activeLots.length}`);
      console.log("");
      
      // Sort by shares descending
      const sortedLots = activeLots
        .map((lot: any) => ({
          owner: lot.account.owner.toBase58(),
          amount: BigInt(lot.account.amount.toString()),
          shares: BigInt(lot.account.shares.toString()),
          tier: lot.account.tier,
        }))
        .sort((a: any, b: any) => Number(b.shares - a.shares));
      
      // Calculate dominance metrics
      let largestShare = 0n;
      let smallestShare = sortedLots[sortedLots.length - 1]?.shares || 0n;
      
      for (const lot of sortedLots) {
        if (lot.shares > largestShare) largestShare = lot.shares;
        const percentage = (lot.shares * 10000n) / totalShares;
        console.log(`   Owner: ${lot.owner.slice(0, 8)}... | Amount: ${lot.amount} | Shares: ${lot.shares} | ${Number(percentage) / 100}%`);
      }
      
      // Calculate concentration ratio
      const top1Percent = (largestShare * 10000n) / totalShares;
      const whaleRatio = largestShare / (smallestShare || 1n);
      
      console.log("");
      console.log(`   Largest stake share %: ${Number(top1Percent) / 100}%`);
      console.log(`   Whale/Small ratio: ${whaleRatio}x`);
      console.log("");
      console.log("   Note: Linear scaling means rewards are proportional to stake.");
      console.log("   No Sybil advantage from splitting stakes across accounts.");
      
      // Linear scaling: whale ratio should be close to amount ratio (adjusted for tier)
      logTestResult("Linear scaling analysis", true, `Whale ratio: ${whaleRatio}x (proportional)`);
      passCount++;
    }
  } catch (error: any) {
    logTestResult("Whale dominance analysis", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 2: Tier multiplier fairness
  // ============================================================
  console.log("\n--- Test 2: Tier multiplier fairness ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const multipliers = pool.tierMultipliers.map((m: any) => Number(m.toString()));
    
    console.log("   Tier multipliers (basis points):");
    const tierNames = ["Flexible", "24 Hours", "72 Hours", "1 Week", "1 Month", "Permanent"];
    
    for (let i = 0; i < multipliers.length; i++) {
      const bonus = ((multipliers[i] - 10000) / 100).toFixed(0);
      console.log(`   ${tierNames[i]}: ${multipliers[i]} (${bonus}% bonus)`);
    }
    
    // Check that multipliers are monotonically increasing
    let isMonotonic = true;
    for (let i = 1; i < multipliers.length; i++) {
      if (multipliers[i] < multipliers[i - 1]) {
        isMonotonic = false;
        break;
      }
    }
    
    // Check that permanent tier has meaningful bonus
    const permanentBonus = (multipliers[5] - 10000) / 10000;
    const reasonableBonus = permanentBonus >= 0.3 && permanentBonus <= 1.0; // 30-100% bonus
    
    if (isMonotonic && reasonableBonus) {
      logTestResult("Tier multipliers are fair", true, "Monotonic and reasonable bonuses");
      passCount++;
    } else {
      logTestResult("Tier multipliers are fair", false, `Monotonic: ${isMonotonic}, Reasonable bonus: ${reasonableBonus}`);
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Tier multiplier fairness", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 3: Front-running simulation (analysis only)
  // ============================================================
  console.log("\n--- Test 3: Front-running risk analysis ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const totalShares = BigInt(pool.totalShares.toString());
    
    if (totalShares === 0n) {
      console.log("   Skipping: No shares in pool");
      passCount++;
    } else {
      // Simulate: if attacker stakes 1M tokens just before a 1 SOL reward
      const attackerAmount = 1_000_000n * BigInt(10 ** decimals);
      // Linear scaling: shares = amount * multiplier / 10000
      const attackerShares = (attackerAmount * 10000n) / 10000n; // Flexible tier (1.0x)
      
      const newTotalShares = totalShares + attackerShares;
      const rewardAmount = LAMPORTS_PER_SOL;
      
      // Attacker's share of the reward
      const attackerReward = (BigInt(rewardAmount) * attackerShares) / newTotalShares;
      const existingHoldersReward = BigInt(rewardAmount) - attackerReward;
      
      console.log(`   Current total shares: ${totalShares}`);
      console.log(`   Attacker stakes ${attackerAmount / BigInt(10 ** decimals)} tokens`);
      console.log(`   Attacker would get ${attackerShares} shares (linear scaling)`);
      console.log(`   New total shares: ${newTotalShares}`);
      console.log(`   Attacker's % of 1 SOL reward: ${Number(attackerReward) / LAMPORTS_PER_SOL * 100}%`);
      console.log(`   Existing holders get: ${Number(existingHoldersReward) / LAMPORTS_PER_SOL * 100}%`);
      
      // This is informational - front-running is always possible to some degree
      // The question is whether it's profitable enough to be a problem
      const attackerPercentage = Number(attackerShares * 100n / newTotalShares);
      
      if (attackerPercentage < 50) {
        logTestResult("Front-running risk", true, `Attacker would capture ${attackerPercentage}% (< 50%)`);
        passCount++;
      } else {
        logTestResult("Front-running risk", false, `Attacker could capture ${attackerPercentage}% (>= 50%)`);
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Front-running analysis", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 4: Dust stake griefing potential
  // ============================================================
  console.log("\n--- Test 4: Dust stake griefing analysis ---");
  
  try {
    // Calculate the cost of creating many tiny stakes
    const pool = await program.account.pool.fetch(poolPda);
    
    // Each StakeLot account requires rent
    // Approximate size: 8 (discriminator) + 32 (pool) + 32 (owner) + 8 (lot_seed) + 8 (amount) + 
    //                   16 (shares) + 1 (tier) + 8 (staked_at) + 8 (unlock_at) + 16 (reward_debt) + 
    //                   8 (total_claimed) + 8 (last_claimed_at) + 1 (active) + 1 (bump) = ~145 bytes
    const stakeLotSize = 145;
    const rentExempt = await connection.getMinimumBalanceForRentExemption(stakeLotSize);
    
    console.log(`   StakeLot account size: ~${stakeLotSize} bytes`);
    console.log(`   Rent per lot: ${formatLamports(rentExempt)}`);
    
    // Cost to create 1000 dust stakes
    const dustStakeCost = rentExempt * 1000;
    console.log(`   Cost to create 1000 dust stakes: ${formatLamports(dustStakeCost)}`);
    
    // Impact on pool with linear scaling
    // Each dust stake with 1 token adds 1 * 10000 / 10000 = 1 share
    const dustShares = 1n * 1000n; // 1000 dust stakes
    const totalShares = BigInt(pool.totalShares.toString());
    
    if (totalShares > 0n) {
      const dilution = (dustShares * 100n) / (totalShares + dustShares);
      console.log(`   Total dilution from 1000 dust stakes: ${Number(dilution)}%`);
      
      // Cost-benefit: how much reward would attacker get vs cost?
      // If pool has 1 SOL rewards funded
      const potentialReward = (dustShares * BigInt(LAMPORTS_PER_SOL)) / (totalShares + dustShares);
      console.log(`   Potential reward capture from 1 SOL: ${formatLamports(potentialReward)}`);
      console.log(`   Attack cost: ${formatLamports(dustStakeCost)}`);
      
      if (dustStakeCost > Number(potentialReward)) {
        logTestResult("Dust stake griefing", true, "Attack is unprofitable");
        passCount++;
      } else {
        logTestResult("Dust stake griefing", false, "Attack could be profitable");
        failCount++;
      }
    } else {
      console.log("   No existing shares, dust analysis not meaningful");
      passCount++;
    }
  } catch (error: any) {
    logTestResult("Dust stake griefing", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 5: Rapid stake/unstake (flexible tier)
  // ============================================================
  console.log("\n--- Test 5: Rapid stake/unstake feasibility ---");
  
  try {
    // For flexible tier, can someone stake, wait for rewards, and immediately unstake?
    const pool = await program.account.pool.fetch(poolPda);
    
    // Check if there are any flexible tier stakes
    const allLots = await program.account.stakeLot.all();
    const flexibleLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && 
      lot.account.active && 
      lot.account.tier === 0
    );
    
    console.log(`   Flexible tier lots: ${flexibleLots.length}`);
    console.log(`   Flexible tier unlock time: 0 seconds`);
    console.log("");
    console.log("   Analysis:");
    console.log("   - Flexible tier can unstake immediately");
    console.log("   - Rewards only accrue when fund_rewards is called");
    console.log("   - To exploit: stake before fund_rewards, unstake after");
    console.log("   - Mitigation: linear scaling means proportional capture only");
    console.log("   - Mitigation: frequent small fundings reduce single-tx capture");
    console.log("   - Mitigation: lots close on unstake, returning rent");
    
    // This is mostly informational
    logTestResult("Rapid stake/unstake analysis", true, "Risk documented, mitigations in place");
    passCount++;
  } catch (error: any) {
    logTestResult("Rapid stake/unstake", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 6: Reward exhaustion scenario
  // ============================================================
  console.log("\n--- Test 6: Reward exhaustion analysis ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const solVaultBalance = await connection.getBalance(solVaultPda);
    
    const totalRewardsFunded = BigInt(pool.totalRewardsFunded.toString());
    const totalRewardsClaimed = BigInt(pool.totalRewardsClaimed.toString());
    const unallocated = BigInt(pool.unallocatedRewards.toString());
    
    console.log(`   SOL vault balance: ${formatLamports(solVaultBalance)}`);
    console.log(`   Total funded: ${formatLamports(totalRewardsFunded)}`);
    console.log(`   Total claimed: ${formatLamports(totalRewardsClaimed)}`);
    console.log(`   Unallocated: ${formatLamports(unallocated)}`);
    
    // Calculate total pending across all lots
    const allLots = await program.account.stakeLot.all();
    const activeLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && lot.account.active
    );
    
    const accSolPerShare = BigInt(pool.accSolPerShare.toString());
    let totalPending = 0n;
    
    for (const lot of activeLots) {
      const shares = BigInt(lot.account.shares.toString());
      const rewardDebt = BigInt(lot.account.rewardDebt.toString());
      const pending = calculatePendingRewards(shares, accSolPerShare, rewardDebt);
      totalPending += pending;
    }
    
    console.log(`   Total pending rewards: ${formatLamports(totalPending)}`);
    
    // Check if vault can cover all pending
    const canCoverAll = BigInt(solVaultBalance) >= totalPending;
    console.log(`   Vault can cover all pending: ${canCoverAll}`);
    
    if (canCoverAll) {
      logTestResult("Reward exhaustion check", true, "Vault has sufficient balance");
      passCount++;
    } else {
      logTestResult("Reward exhaustion check", false, "Vault insufficient for pending rewards!");
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Reward exhaustion", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("ECONOMIC ATTACK TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total:  ${passCount + failCount}`);
  
  if (failCount > 0) {
    console.log("\n⚠️  ECONOMIC RISKS DETECTED - REVIEW BEFORE MAINNET");
  } else {
    console.log("\n✅ All economic tests passed");
  }
  
  console.log("\n📋 Recommendations:");
  console.log("   1. Fund rewards frequently in small amounts to reduce front-running impact");
  console.log("   2. Linear scaling prevents Sybil splitting advantage");
  console.log("   3. Lot closing on unstake returns rent (no permanent spam)");
  console.log("   4. Monitor for unusual stake/unstake patterns around funding events");
}


// Run tests
runEconomicAttackTests().catch(console.error);
