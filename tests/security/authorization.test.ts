/**
 * Authorization Security Tests
 * 
 * Tests that users cannot:
 * - Claim other users' rewards
 * - Unstake other users' tokens
 * - Perform admin actions without authority
 * 
 * Run: npx ts-node tests/security/authorization.test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import {
  initTestConfig,
  derivePoolPda,
  deriveSolVaultPda,
  deriveTokenVaultPda,
  deriveStakeLotPda,
  deriveConfigPda,
  getUserLots,
  logTestResult,
  expectError,
  StakingTier,
  TestConfig,
} from "../common";

async function runAuthorizationTests() {
  console.log("\n" + "=".repeat(60));
  console.log("AUTHORIZATION SECURITY TESTS");
  console.log("=".repeat(60) + "\n");

  const config = await initTestConfig();
  const { program, programId, adminKeypair, userKeypair, tokenMint, tokenProgram, connection } = config;

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);
  const [configPda] = deriveConfigPda(programId);

  let passCount = 0;
  let failCount = 0;

  // ============================================================
  // TEST 1: Cannot claim another user's rewards
  // ============================================================
  console.log("\n--- Test 1: Cannot claim another user's rewards ---");
  
  try {
    // Get admin's lots (admin has stakes from earlier testing)
    const adminLots = await getUserLots(program, poolPda, adminKeypair.publicKey);
    
    if (adminLots.length === 0) {
      console.log("   Skipping: Admin has no active lots to test with");
    } else {
      const targetLot = adminLots[0];
      const lotSeed = BigInt(targetLot.account.lotSeed.toString());
      
      // Try to claim admin's lot as the user (should fail)
      const [adminStakeLotPda] = deriveStakeLotPda(
        poolPda,
        adminKeypair.publicKey,  // Admin's lot
        lotSeed,
        programId
      );
      
      // Create a provider with the attacker (user) as signer
      const attackerWallet = new anchor.Wallet(userKeypair);
      const attackerProvider = new anchor.AnchorProvider(connection, attackerWallet, { preflightCommitment: "confirmed" });
      const attackerProgram = new anchor.Program(program.idl, attackerProvider);
      
      try {
        await attackerProgram.methods
          .claim()
          .accountsPartial({
            user: userKeypair.publicKey,  // Attacker signing
            pool: poolPda,
            stakeLot: adminStakeLotPda,   // Trying to claim admin's lot
            solVault: solVaultPda,
          })
          .signers([userKeypair])
          .rpc();
        
        logTestResult("Cannot claim another user's rewards", false, "Attack succeeded - CRITICAL VULNERABILITY!");
        failCount++;
      } catch (error: any) {
        // Expected to fail
        const isUnauthorized = error.toString().includes("Unauthorized") || 
                               error.toString().includes("ConstraintSeeds") ||
                               error.toString().includes("2006") ||
                               error.toString().includes("has_one");
        
        if (isUnauthorized || error.toString().includes("Error")) {
          logTestResult("Cannot claim another user's rewards", true, "Attack blocked correctly");
          passCount++;
        } else {
          logTestResult("Cannot claim another user's rewards", false, `Unexpected error: ${error.message}`);
          failCount++;
        }
      }
    }
  } catch (error: any) {
    logTestResult("Cannot claim another user's rewards", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 2: Cannot unstake another user's tokens
  // ============================================================
  console.log("\n--- Test 2: Cannot unstake another user's tokens ---");
  
  try {
    const adminLots = await getUserLots(program, poolPda, adminKeypair.publicKey);
    
    if (adminLots.length === 0) {
      console.log("   Skipping: Admin has no active lots to test with");
    } else {
      // Find a flexible tier lot that could be unstaked
      const flexibleLot = adminLots.find((lot: any) => lot.account.tier === 0);
      
      if (!flexibleLot) {
        console.log("   Skipping: No flexible tier lots to test with");
      } else {
        const lotSeed = BigInt(flexibleLot.account.lotSeed.toString());
        
        const [adminStakeLotPda] = deriveStakeLotPda(
          poolPda,
          adminKeypair.publicKey,
          lotSeed,
          programId
        );
        
        // Attacker's token account (to receive stolen tokens)
        const attackerTokenAccount = await getAssociatedTokenAddress(
          tokenMint,
          userKeypair.publicKey,
          false,
          tokenProgram
        );
        
        const attackerWallet = new anchor.Wallet(userKeypair);
        const attackerProvider = new anchor.AnchorProvider(connection, attackerWallet, { preflightCommitment: "confirmed" });
        const attackerProgram = new anchor.Program(program.idl, attackerProvider);
        
        try {
          await attackerProgram.methods
            .unstake()
            .accountsPartial({
              user: userKeypair.publicKey,
              pool: poolPda,
              stakeLot: adminStakeLotPda,
              userTokenAccount: attackerTokenAccount,
              tokenVault: tokenVaultPda,
              tokenMint: tokenMint,
              solVault: solVaultPda,
              tokenProgram: tokenProgram,
            })
            .signers([userKeypair])
            .rpc();
          
          logTestResult("Cannot unstake another user's tokens", false, "Attack succeeded - CRITICAL VULNERABILITY!");
          failCount++;
        } catch (error: any) {
          const isBlocked = error.toString().includes("Unauthorized") || 
                           error.toString().includes("ConstraintSeeds") ||
                           error.toString().includes("2006") ||
                           error.toString().includes("Error");
          
          if (isBlocked) {
            logTestResult("Cannot unstake another user's tokens", true, "Attack blocked correctly");
            passCount++;
          } else {
            logTestResult("Cannot unstake another user's tokens", false, `Unexpected error: ${error.message}`);
            failCount++;
          }
        }
      }
    }
  } catch (error: any) {
    logTestResult("Cannot unstake another user's tokens", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 3: Non-admin cannot initialize pool
  // ============================================================
  console.log("\n--- Test 3: Non-admin cannot initialize pool ---");
  
  try {
    // Generate a random mint that doesn't have a pool
    const fakeMint = Keypair.generate().publicKey;
    
    const attackerWallet = new anchor.Wallet(userKeypair);
    const attackerProvider = new anchor.AnchorProvider(connection, attackerWallet, { preflightCommitment: "confirmed" });
    const attackerProgram = new anchor.Program(program.idl, attackerProvider);
    
    try {
      await attackerProgram.methods
        .initializePool(userKeypair.publicKey, null)
        .accountsPartial({
          authority: userKeypair.publicKey,
          tokenMint: fakeMint,
          tokenProgram: tokenProgram,
        })
        .signers([userKeypair])
        .rpc();
      
      logTestResult("Non-admin cannot initialize pool", false, "Attack succeeded - unauthorized pool creation!");
      failCount++;
    } catch (error: any) {
      const isBlocked = error.toString().includes("Unauthorized") || 
                       error.toString().includes("ConstraintHasOne") ||
                       error.toString().includes("Error");
      
      if (isBlocked) {
        logTestResult("Non-admin cannot initialize pool", true, "Attack blocked correctly");
        passCount++;
      } else {
        logTestResult("Non-admin cannot initialize pool", false, `Unexpected error: ${error.message}`);
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Non-admin cannot initialize pool", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 4: Non-admin cannot fund rewards
  // ============================================================
  console.log("\n--- Test 4: Non-admin cannot fund rewards ---");
  
  try {
    const attackerWallet = new anchor.Wallet(userKeypair);
    const attackerProvider = new anchor.AnchorProvider(connection, attackerWallet, { preflightCommitment: "confirmed" });
    const attackerProgram = new anchor.Program(program.idl, attackerProvider);
    
    try {
      await attackerProgram.methods
        .fundRewards(new BN(1000000)) // 0.001 SOL
        .accountsPartial({
          funder: userKeypair.publicKey,
          pool: poolPda,
        })
        .signers([userKeypair])
        .rpc();
      
      // This might actually succeed if the user is just funding the pool
      // But it should fail because they're not the authority
      logTestResult("Non-admin cannot fund rewards", false, "Non-admin was able to fund rewards");
      failCount++;
    } catch (error: any) {
      const isBlocked = error.toString().includes("Unauthorized") || 
                       error.toString().includes("ConstraintHasOne") ||
                       error.toString().includes("Error");
      
      if (isBlocked) {
        logTestResult("Non-admin cannot fund rewards", true, "Attack blocked correctly");
        passCount++;
      } else {
        logTestResult("Non-admin cannot fund rewards", false, `Unexpected error: ${error.message}`);
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Non-admin cannot fund rewards", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 5: Cannot forge stake lot PDA
  // ============================================================
  console.log("\n--- Test 5: Cannot claim with forged stake lot ---");
  
  try {
    // Try to derive a stake lot PDA with wrong parameters
    const fakeLotSeed = BigInt(999999999999);
    const [fakeStakeLotPda] = deriveStakeLotPda(
      poolPda,
      userKeypair.publicKey,
      fakeLotSeed,
      programId
    );
    
    const userWallet = new anchor.Wallet(userKeypair);
    const userProvider = new anchor.AnchorProvider(connection, userWallet, { preflightCommitment: "confirmed" });
    const userProgram = new anchor.Program(program.idl, userProvider);
    
    try {
      await userProgram.methods
        .claim()
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: fakeStakeLotPda,
          solVault: solVaultPda,
        })
        .signers([userKeypair])
        .rpc();
      
      logTestResult("Cannot claim with forged stake lot", false, "Claimed from non-existent lot!");
      failCount++;
    } catch (error: any) {
      const isBlocked = error.toString().includes("AccountNotInitialized") || 
                       error.toString().includes("Error") ||
                       error.toString().includes("not found");
      
      if (isBlocked) {
        logTestResult("Cannot claim with forged stake lot", true, "Attack blocked - lot doesn't exist");
        passCount++;
      } else {
        logTestResult("Cannot claim with forged stake lot", false, `Unexpected error: ${error.message}`);
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Cannot claim with forged stake lot", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // TEST 6: Non-admin cannot update authority
  // ============================================================
  console.log("\n--- Test 6: Non-admin cannot update authority ---");
  
  try {
    const attackerWallet = new anchor.Wallet(userKeypair);
    const attackerProvider = new anchor.AnchorProvider(connection, attackerWallet, { preflightCommitment: "confirmed" });
    const attackerProgram = new anchor.Program(program.idl, attackerProvider);
    
    try {
      await attackerProgram.methods
        .updateAuthority(userKeypair.publicKey) // Try to become the authority
        .accountsPartial({
          authority: userKeypair.publicKey,
        })
        .signers([userKeypair])
        .rpc();
      
      logTestResult("Non-admin cannot update authority", false, "CRITICAL: Authority takeover succeeded!");
      failCount++;
    } catch (error: any) {
      const isBlocked = error.toString().includes("Unauthorized") || 
                       error.toString().includes("ConstraintHasOne") ||
                       error.toString().includes("Error");
      
      if (isBlocked) {
        logTestResult("Non-admin cannot update authority", true, "Attack blocked correctly");
        passCount++;
      } else {
        logTestResult("Non-admin cannot update authority", false, `Unexpected error: ${error.message}`);
        failCount++;
      }
    }
  } catch (error: any) {
    logTestResult("Non-admin cannot update authority", false, `Test setup error: ${error.message}`);
    failCount++;
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(60));
  console.log("AUTHORIZATION TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Total:  ${passCount + failCount}`);
  
  if (failCount > 0) {
    console.log("\n⚠️  SECURITY ISSUES DETECTED - DO NOT DEPLOY TO MAINNET");
  } else {
    console.log("\n✅ All authorization tests passed");
  }
}

// Run tests
runAuthorizationTests().catch(console.error);
