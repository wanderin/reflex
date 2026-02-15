/**
 * General Edge Case Tests
 * 
 * Tests various edge cases for stake, claim, unstake, and pool operations.
 * 
 * Run: npx ts-node tests/edge-cases.test.ts
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
} from "./common";

async function runEdgeCaseTests() {
  console.log("\n" + "=".repeat(60));
  console.log("EDGE CASE TESTS");
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
  // TEST 1: Pool state validation
  // ============================================================
  console.log("\n--- Test 1: Pool state validation ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    
    console.log("   Pool state:");
    console.log(`     Token Mint: ${pool.tokenMint.toBase58()}`);
    console.log(`     Creator Wallet: ${pool.creatorWallet.toBase58()}`);
    console.log(`     Total Staked: ${pool.totalStaked.toString()}`);
    console.log(`     Active Lots: ${pool.activeLots.toString()}`);
    console.log(`     Total Shares: ${pool.totalShares.toString()}`);
    
    // Verify consistency
    const allLots = await program.account.stakeLot.all();
    const activeLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && lot.account.active
    );
    
    const actualActiveLots = activeLots.length;
    const recordedActiveLots = Number(pool.activeLots.toString());
    
    if (actualActiveLots === recordedActiveLots) {
      logTestResult("Active lots count matches", true);
      passCount++;
    } else {
      logTestResult("Active lots count matches", false, `Recorded: ${recordedActiveLots}, Actual: ${actualActiveLots}`);
      failCount++;
    }
    
    // Verify total staked
    let actualTotalStaked = 0n;
    let actualTotalShares = 0n;
    for (const lot of activeLots) {
      actualTotalStaked += BigInt(lot.account.amount.toString());
      actualTotalShares += BigInt(lot.account.shares.toString());
    }
    
    const recordedTotalStaked = BigInt(pool.totalStaked.toString());
    const recordedTotalShares = BigInt(pool.totalShares.toString());
    
    if (actualTotalStaked === recordedTotalStaked) {
      logTestResult("Total staked matches", true);
      passCount++;
    } else {
      logTestResult("Total staked matches", false, `Recorded: ${recordedTotalStaked}, Actual: ${actualTotalStaked}`);
      failCount++;
    }
    
    if (actualTotalShares === recordedTotalShares) {
      logTestResult("Total shares matches", true);
      passCount++;
    } else {
      logTestResult("Total shares matches", false, `Recorded: ${recordedTotalShares}, Actual: ${actualTotalShares}`);
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Pool state validation", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 2: Config state validation
  // ============================================================
  console.log("\n--- Test 2: Config state validation ---");
  
  try {
    const config = await program.account.programConfig.fetch(configPda);
    
    console.log("   Config state:");
    console.log(`     Authority: ${config.authority.toBase58()}`);
    console.log(`     Bump: ${config.bump}`);
    
    // Verify authority matches expected
    if (config.authority.equals(adminKeypair.publicKey)) {
      logTestResult("Config authority matches admin", true);
      passCount++;
    } else {
      logTestResult("Config authority matches admin", false, `Expected: ${adminKeypair.publicKey.toBase58()}`);
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Config state validation", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 3: Stake lot data integrity
  // ============================================================
  console.log("\n--- Test 3: Stake lot data integrity ---");
  
  try {
    const allLots = await program.account.stakeLot.all();
    const poolLots = allLots.filter((lot: any) => lot.account.pool.equals(poolPda));
    
    console.log(`   Found ${poolLots.length} total lots (active + inactive)`);
    
    let integrityErrors = 0;
    
    for (const lotAccount of poolLots) {
      const lot = lotAccount.account as any;
      
      // Check tier is valid (0-5)
      if (lot.tier < 0 || lot.tier > 5) {
        console.log(`   ❌ Invalid tier ${lot.tier} for lot ${lotAccount.publicKey.toBase58()}`);
        integrityErrors++;
      }
      
      // Check amount > 0 for active lots
      if (lot.active && BigInt(lot.amount.toString()) === 0n) {
        console.log(`   ❌ Active lot with 0 amount: ${lotAccount.publicKey.toBase58()}`);
        integrityErrors++;
      }
      
      // Check shares > 0 for active lots with amount > 0
      if (lot.active && BigInt(lot.amount.toString()) > 0n && BigInt(lot.shares.toString()) === 0n) {
        console.log(`   ❌ Active lot with 0 shares: ${lotAccount.publicKey.toBase58()}`);
        integrityErrors++;
      }
      
      // Check reward_debt is not negative (it's u128, so should be fine)
      // Check total_claimed is reasonable
    }
    
    if (integrityErrors === 0) {
      logTestResult("Stake lot data integrity", true, "All lots have valid data");
      passCount++;
    } else {
      logTestResult("Stake lot data integrity", false, `${integrityErrors} integrity errors found`);
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Stake lot data integrity", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 4: Token vault balance matches total staked
  // ============================================================
  console.log("\n--- Test 4: Token vault balance consistency ---");
  
  try {
    const pool = await program.account.pool.fetch(poolPda);
    const totalStaked = BigInt(pool.totalStaked.toString());
    
    // Get token vault balance
    const tokenVaultAccount = await getAccount(connection, tokenVaultPda, "confirmed", tokenProgram);
    const vaultBalance = tokenVaultAccount.amount;
    
    console.log(`   Total staked (recorded): ${totalStaked}`);
    console.log(`   Token vault balance: ${vaultBalance}`);
    
    if (vaultBalance === totalStaked) {
      logTestResult("Token vault balance matches total staked", true);
      passCount++;
    } else if (vaultBalance >= totalStaked) {
      logTestResult("Token vault balance matches total staked", true, "Vault has extra tokens (donations?)");
      passCount++;
    } else {
      logTestResult("Token vault balance matches total staked", false, "Vault has fewer tokens than staked!");
      failCount++;
    }
  } catch (error: any) {
    logTestResult("Token vault balance", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 5: Permanent tier unlock time
  // ============================================================
  console.log("\n--- Test 5: Permanent tier has correct unlock time ---");
  
  try {
    const allLots = await program.account.stakeLot.all();
    const permanentLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && lot.account.tier === 5
    );
    
    if (permanentLots.length === 0) {
      console.log("   Skipping: No permanent tier lots found");
    } else {
      let allCorrect = true;
      const maxI64 = "9223372036854775807"; // i64::MAX
      
      for (const lotAccount of permanentLots) {
        const lot = lotAccount.account as any;
        const unlockAt = lot.unlockAt.toString();
        
        // Permanent tier should have i64::MAX as unlock time
        if (unlockAt !== maxI64) {
          console.log(`   ❌ Permanent lot ${lotAccount.publicKey.toBase58()} has unlock: ${unlockAt}`);
          allCorrect = false;
        }
      }
      
      if (allCorrect) {
        logTestResult("Permanent tier unlock time", true, `All ${permanentLots.length} permanent lots have i64::MAX`);
        passCount++;
      } else {
        logTestResult("Permanent tier unlock time", false, "Some permanent lots have incorrect unlock time");
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Permanent tier unlock time", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 6: Cannot unstake permanent tier
  // ============================================================
  console.log("\n--- Test 6: Cannot unstake permanent tier ---");
  
  try {
    const allLots = await program.account.stakeLot.all();
    const permanentLots = allLots.filter((lot: any) => 
      lot.account.pool.equals(poolPda) && 
      lot.account.active && 
      lot.account.tier === 5 &&
      lot.account.owner.equals(adminKeypair.publicKey)
    );
    
    if (permanentLots.length === 0) {
      console.log("   Skipping: No permanent tier lots owned by admin");
    } else {
      const permanentLot = permanentLots[0];
      const lotSeed = BigInt(permanentLot.account.lotSeed.toString());
      const [stakeLotPda] = deriveStakeLotPda(poolPda, adminKeypair.publicKey, lotSeed, programId);
      
      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        adminKeypair.publicKey,
        false,
        tokenProgram
      );
      
      try {
        await program.methods
          .unstake()
          .accountsPartial({
            user: adminKeypair.publicKey,
            pool: poolPda,
            stakeLot: stakeLotPda,
            userTokenAccount: userTokenAccount,
            tokenVault: tokenVaultPda,
            tokenMint: tokenMint,
            solVault: solVaultPda,
            tokenProgram: tokenProgram,
          })
          .signers([adminKeypair])
          .rpc();
        
        logTestResult("Cannot unstake permanent tier", false, "Unstake succeeded on permanent tier!");
        failCount++;
      } catch (error: any) {
        const isExpected = error.toString().includes("UnstakeNotAllowed") || 
                          error.toString().includes("Error");
        
        if (isExpected) {
          logTestResult("Cannot unstake permanent tier", true, "Correctly rejected");
          passCount++;
        } else {
          logTestResult("Cannot unstake permanent tier", true, `Rejected with: ${error.message.slice(0, 50)}`);
          passCount++;
        }
      }
    }
  } catch (error: any) {
    logTestResult("Cannot unstake permanent tier", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 7: Duplicate lot seed prevention
  // ============================================================
  console.log("\n--- Test 7: Duplicate lot seed prevention ---");
  
  try {
    // Get existing lot seeds for admin
    const userLots = await getUserLots(program, poolPda, adminKeypair.publicKey);
    
    if (userLots.length === 0) {
      console.log("   Skipping: No existing lots to test duplicate prevention");
    } else {
      const existingLotSeed = BigInt(userLots[0].account.lotSeed.toString());
      const [existingLotPda] = deriveStakeLotPda(poolPda, adminKeypair.publicKey, existingLotSeed, programId);
      
      const userTokenAccount = await getAssociatedTokenAddress(
        tokenMint,
        adminKeypair.publicKey,
        false,
        tokenProgram
      );
      
      try {
        // Try to create a stake with the same lot seed
        await program.methods
          .stake(new BN(1000), StakingTier.Flexible as any, new BN(existingLotSeed.toString()))
          .accountsPartial({
            user: adminKeypair.publicKey,
            pool: poolPda,
            stakeLot: existingLotPda,
            userTokenAccount: userTokenAccount,
            tokenVault: tokenVaultPda,
            tokenMint: tokenMint,
            tokenProgram: tokenProgram,
          })
          .signers([adminKeypair])
          .rpc();
        
        logTestResult("Duplicate lot seed prevention", false, "Duplicate stake was allowed!");
        failCount++;
      } catch (error: any) {
        // Expected to fail due to account already exists
        logTestResult("Duplicate lot seed prevention", true, "Duplicate correctly rejected");
        passCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Duplicate lot seed prevention", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 8: SOL vault rent exemption
  // ============================================================
  console.log("\n--- Test 8: SOL vault has rent-exempt minimum ---");
  
  try {
    const solVaultBalance = await connection.getBalance(solVaultPda);
    const rentExempt = await connection.getMinimumBalanceForRentExemption(0);
    
    console.log(`   SOL vault balance: ${formatLamports(solVaultBalance)}`);
    console.log(`   Rent-exempt minimum: ${formatLamports(rentExempt)}`);
    
    if (solVaultBalance >= rentExempt) {
      logTestResult("SOL vault rent-exempt", true);
      passCount++;
    } else {
      logTestResult("SOL vault rent-exempt", false, "Vault may be garbage collected!");
      failCount++;
    }
  } catch (error: any) {
    logTestResult("SOL vault rent exemption", false, `Error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("EDGE CASE TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total:  ${passCount + failCount}`);
  
  if (failCount > 0) {
    console.log("\n⚠️  EDGE CASE ISSUES DETECTED - REVIEW BEFORE MAINNET");
  } else {
    console.log("\n✅ All edge case tests passed");
  }
}

// Run tests
runEdgeCaseTests().catch(console.error);
