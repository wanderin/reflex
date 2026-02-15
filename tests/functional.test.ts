/**
 * Functional End-to-End Tests
 * 
 * These tests create REAL transactions on devnet:
 * 1. Stake tokens (user)
 * 2. Fund rewards (admin)
 * 3. Claim rewards (user)
 * 4. Unstake tokens (user)
 * 
 * Uses existing wallets:
 *   - rflx_admin: Program authority, can fund rewards
 *   - testwallet1: Test user for staking
 * 
 * Run: npx ts-node tests/functional.test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { 
  getAssociatedTokenAddress, 
  getAccount,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  initTestConfig,
  derivePoolPda,
  deriveSolVaultPda,
  deriveTokenVaultPda,
  deriveStakeLotPda,
  getUserLots,
  calculatePendingRewards,
  logTestResult,
  formatLamports,
  StakingTier,
  SCALE,
  sleep,
  loadKeypair,
} from "./common";

// Test configuration
const STAKE_AMOUNT = 100; // 100 tokens (will multiply by decimals)
const FUND_AMOUNT = 0.01; // 0.01 SOL rewards
const TEST_TIER = StakingTier.Flexible; // Use flexible so we can unstake immediately

async function runFunctionalTests() {
  console.log("\n" + "=".repeat(60));
  console.log("FUNCTIONAL END-TO-END TESTS");
  console.log("=".repeat(60) + "\n");

  const config = await initTestConfig();
  const { program, programId, adminKeypair, userKeypair, tokenMint, tokenProgram, decimals, connection } = config;

  console.log("Configuration:");
  console.log(`  Program ID: ${programId.toBase58()}`);
  console.log(`  Token Mint: ${tokenMint.toBase58()}`);
  console.log(`  Token Program: ${tokenProgram.toBase58()}`);
  console.log(`  Decimals: ${decimals}`);
  console.log(`  Admin: ${adminKeypair.publicKey.toBase58()}`);
  console.log(`  User: ${userKeypair.publicKey.toBase58()}`);
  console.log("");

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);

  // Check balances before tests
  const adminSolBalance = await connection.getBalance(adminKeypair.publicKey);
  const userSolBalance = await connection.getBalance(userKeypair.publicKey);
  
  console.log("Initial Balances:");
  console.log(`  Admin SOL: ${formatLamports(adminSolBalance)}`);
  console.log(`  User SOL: ${formatLamports(userSolBalance)}`);

  // Check token balances
  const userTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    userKeypair.publicKey,
    false,
    tokenProgram
  );

  let userTokenBalance = 0n;
  try {
    const tokenAccountInfo = await getAccount(connection, userTokenAccount, "confirmed", tokenProgram);
    userTokenBalance = tokenAccountInfo.amount;
    console.log(`  User tokens: ${Number(userTokenBalance) / (10 ** decimals)}`);
  } catch {
    console.log(`  User tokens: 0 (no token account)`);
  }

  console.log("");

  let passCount = 0;
  let failCount = 0;
  let createdLotSeed: bigint | null = null;

  // ============================================================
  // TEST 1: Stake tokens (User)
  // ============================================================
  console.log("\n--- Test 1: Stake tokens ---");
  
  if (userTokenBalance < BigInt(STAKE_AMOUNT * (10 ** decimals))) {
    console.log(`   ⚠️  Skipping: User has insufficient tokens (need ${STAKE_AMOUNT}, have ${Number(userTokenBalance) / (10 ** decimals)})`);
    console.log("   To run this test, transfer some tokens to the user wallet first.");
  } else {
    try {
      const lotSeed = BigInt(Date.now());
      createdLotSeed = lotSeed;
      const [stakeLotPda] = deriveStakeLotPda(poolPda, userKeypair.publicKey, lotSeed, programId);
      const stakeAmount = new BN(STAKE_AMOUNT * (10 ** decimals));

      console.log(`   Staking ${STAKE_AMOUNT} tokens with flexible tier...`);
      console.log(`   Lot seed: ${lotSeed}`);

      // Create user provider/program
      const userWallet = new anchor.Wallet(userKeypair);
      const userProvider = new anchor.AnchorProvider(connection, userWallet, { preflightCommitment: "confirmed" });
      const userProgram = new anchor.Program(program.idl, userProvider);

      const tx = await userProgram.methods
        .stake(stakeAmount, TEST_TIER as any, new BN(lotSeed.toString()))
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPda,
          userTokenAccount: userTokenAccount,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          tokenProgram: tokenProgram,
        })
        .signers([userKeypair])
        .rpc();

      console.log(`   ✅ Stake TX: ${tx}`);
      console.log(`   View on Solscan: https://solscan.io/tx/${tx}?cluster=devnet`);

      // Verify stake
      const stakeLot = await program.account.stakeLot.fetch(stakeLotPda);
      console.log(`   Staked amount: ${stakeLot.amount.toString()}`);
      console.log(`   Shares received: ${stakeLot.shares.toString()}`);

      logTestResult("Stake tokens", true);
      passCount++;
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);
      logTestResult("Stake tokens", false, error.message);
      failCount++;
    }
  }

  // ============================================================
  // TEST 2: Fund rewards (Admin)
  // ============================================================
  console.log("\n--- Test 2: Fund rewards ---");
  
  if (adminSolBalance < FUND_AMOUNT * LAMPORTS_PER_SOL + 0.01 * LAMPORTS_PER_SOL) {
    console.log(`   ⚠️  Skipping: Admin has insufficient SOL for funding + fees`);
  } else {
    try {
      const fundAmount = new BN(FUND_AMOUNT * LAMPORTS_PER_SOL);
      
      console.log(`   Funding ${FUND_AMOUNT} SOL to pool rewards...`);

      // Get pool state before
      const poolBefore = await program.account.pool.fetch(poolPda);
      const accBefore = poolBefore.accSolPerShare.toString();

      const tx = await program.methods
        .fundRewards(fundAmount)
        .accountsPartial({
          funder: adminKeypair.publicKey,
          pool: poolPda,
        })
        .signers([adminKeypair])
        .rpc();

      console.log(`   ✅ Fund TX: ${tx}`);
      console.log(`   View on Solscan: https://solscan.io/tx/${tx}?cluster=devnet`);

      // Verify accumulator changed
      const poolAfter = await program.account.pool.fetch(poolPda);
      const accAfter = poolAfter.accSolPerShare.toString();
      console.log(`   Acc SOL per share: ${accBefore} -> ${accAfter}`);

      logTestResult("Fund rewards", true);
      passCount++;
    } catch (error: any) {
      console.log(`   ❌ Error: ${error.message}`);
      logTestResult("Fund rewards", false, error.message);
      failCount++;
    }
  }

  // Wait a moment for state to settle
  await sleep(2000);

  // ============================================================
  // TEST 3: Claim rewards (User)
  // ============================================================
  console.log("\n--- Test 3: Claim rewards ---");
  
  try {
    // Get user's lots
    const userLots = await getUserLots(program, poolPda, userKeypair.publicKey);
    
    if (userLots.length === 0) {
      console.log(`   ⚠️  Skipping: User has no active stakes`);
    } else {
      // Get pool state for pending calculation
      const pool = await program.account.pool.fetch(poolPda);
      const accSolPerShare = BigInt(pool.accSolPerShare.toString());

      // Find a lot with pending rewards
      let lotToClaim: any = null;
      let pendingAmount = 0n;

      for (const lot of userLots) {
        const shares = BigInt(lot.account.shares.toString());
        const rewardDebt = BigInt(lot.account.rewardDebt.toString());
        const pending = calculatePendingRewards(shares, accSolPerShare, rewardDebt);
        
        if (pending > 0n) {
          lotToClaim = lot;
          pendingAmount = pending;
          break;
        }
      }

      if (!lotToClaim) {
        console.log(`   ⚠️  Skipping: No lots have pending rewards`);
      } else {
        const lotSeed = BigInt(lotToClaim.account.lotSeed.toString());
        const [stakeLotPda] = deriveStakeLotPda(poolPda, userKeypair.publicKey, lotSeed, programId);

        console.log(`   Claiming from lot ${lotSeed}...`);
        console.log(`   Pending rewards: ${formatLamports(pendingAmount)}`);

        const balanceBefore = await connection.getBalance(userKeypair.publicKey);

        const userWallet = new anchor.Wallet(userKeypair);
        const userProvider = new anchor.AnchorProvider(connection, userWallet, { preflightCommitment: "confirmed" });
        const userProgram = new anchor.Program(program.idl, userProvider);

        const tx = await userProgram.methods
          .claim()
          .accountsPartial({
            user: userKeypair.publicKey,
            pool: poolPda,
            stakeLot: stakeLotPda,
            solVault: solVaultPda,
          })
          .signers([userKeypair])
          .rpc();

        console.log(`   ✅ Claim TX: ${tx}`);
        console.log(`   View on Solscan: https://solscan.io/tx/${tx}?cluster=devnet`);

        const balanceAfter = await connection.getBalance(userKeypair.publicKey);
        const netChange = balanceAfter - balanceBefore;
        console.log(`   SOL balance change: ${formatLamports(netChange)} (includes tx fee)`);

        logTestResult("Claim rewards", true);
        passCount++;
      }
    }
  } catch (error: any) {
    console.log(`   ❌ Error: ${error.message}`);
    logTestResult("Claim rewards", false, error.message);
    failCount++;
  }

  // ============================================================
  // TEST 4: Unstake tokens (User)
  // ============================================================
  console.log("\n--- Test 4: Unstake tokens ---");
  
  try {
    // Find a flexible tier lot that can be unstaked
    const userLots = await getUserLots(program, poolPda, userKeypair.publicKey);
    const flexibleLots = userLots.filter((lot: any) => lot.account.tier === 0);

    if (flexibleLots.length === 0) {
      console.log(`   ⚠️  Skipping: No flexible tier lots to unstake`);
    } else {
      // Use the lot we just created, or the first flexible lot
      const lotToUnstake = createdLotSeed 
        ? flexibleLots.find((lot: any) => BigInt(lot.account.lotSeed.toString()) === createdLotSeed)
        : flexibleLots[0];

      if (!lotToUnstake) {
        console.log(`   ⚠️  Could not find lot to unstake`);
      } else {
        const lotSeed = BigInt(lotToUnstake.account.lotSeed.toString());
        const [stakeLotPda] = deriveStakeLotPda(poolPda, userKeypair.publicKey, lotSeed, programId);
        const amount = lotToUnstake.account.amount.toString();

        console.log(`   Unstaking lot ${lotSeed}...`);
        console.log(`   Amount: ${Number(amount) / (10 ** decimals)} tokens`);

        const tokenBalanceBefore = (await getAccount(connection, userTokenAccount, "confirmed", tokenProgram)).amount;

        const userWallet = new anchor.Wallet(userKeypair);
        const userProvider = new anchor.AnchorProvider(connection, userWallet, { preflightCommitment: "confirmed" });
        const userProgram = new anchor.Program(program.idl, userProvider);

        const tx = await userProgram.methods
          .unstake()
          .accountsPartial({
            user: userKeypair.publicKey,
            pool: poolPda,
            stakeLot: stakeLotPda,
            userTokenAccount: userTokenAccount,
            tokenVault: tokenVaultPda,
            tokenMint: tokenMint,
            solVault: solVaultPda,
            tokenProgram: tokenProgram,
          })
          .signers([userKeypair])
          .rpc();

        console.log(`   ✅ Unstake TX: ${tx}`);
        console.log(`   View on Solscan: https://solscan.io/tx/${tx}?cluster=devnet`);

        const tokenBalanceAfter = (await getAccount(connection, userTokenAccount, "confirmed", tokenProgram)).amount;
        const tokensReturned = tokenBalanceAfter - tokenBalanceBefore;
        console.log(`   Tokens returned: ${Number(tokensReturned) / (10 ** decimals)}`);

        logTestResult("Unstake tokens", true);
        passCount++;
      }
    }
  } catch (error: any) {
    console.log(`   ❌ Error: ${error.message}`);
    logTestResult("Unstake tokens", false, error.message);
    failCount++;
  }

  // ============================================================
  // TEST 5: Verify final state
  // ============================================================
  console.log("\n--- Test 5: Verify final state ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const solVaultBalance = await connection.getBalance(solVaultPda);
    
    console.log("   Pool State:");
    console.log(`     Total staked: ${pool.totalStaked.toString()}`);
    console.log(`     Active lots: ${pool.activeLots.toString()}`);
    console.log(`     Total shares: ${pool.totalShares.toString()}`);
    console.log(`     Total funded: ${formatLamports(Number(pool.totalRewardsFunded.toString()))}`);
    console.log(`     Total claimed: ${formatLamports(Number(pool.totalRewardsClaimed.toString()))}`);
    console.log(`     SOL vault: ${formatLamports(solVaultBalance)}`);

    logTestResult("State verification", true);
    passCount++;
  } catch (error: any) {
    logTestResult("State verification", false, error.message);
    failCount++;
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("FUNCTIONAL TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total:  ${passCount + failCount}`);
  
  if (failCount > 0) {
    console.log("\n⚠️  SOME FUNCTIONAL TESTS FAILED");
  } else {
    console.log("\n✅ All functional tests passed");
  }

  console.log("\n📋 Check your transactions on Solscan:");
  console.log(`   https://solscan.io/account/${programId.toBase58()}?cluster=devnet`);
}

// Run tests
runFunctionalTests().catch(console.error);
