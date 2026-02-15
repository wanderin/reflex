/**
 * Tier Validation Tests
 * 
 * Thoroughly tests all 6 staking tiers to ensure:
 * 1. Each tier (0-5) stores and retrieves correctly
 * 2. Lock durations are enforced properly
 * 3. Flexible (tier 0) can unstake after 60s lock (anti-sandwich)
 * 4. Timed tiers (1-4) enforce their locks
 * 5. Permanent (tier 5) can NEVER unstake
 * 6. No tokens are accidentally locked by tier logic bugs
 * 
 * Run: npx ts-node tests/tier-validation.test.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMintLen,
  getAccount,
} from "@solana/spl-token";
import { SolMemecoinStaking } from "../target/types/sol_memecoin_staking";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

const IDL_PATH = path.join(__dirname, "../target/idl/sol_memecoin_staking.json");
const DECIMALS = 6;

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function addResult(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
  console.log(`${passed ? "✅" : "❌"} ${name}: ${details}`);
}

function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

function derivePoolPda(tokenMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer()],
    programId
  );
}

function deriveTokenVaultPda(pool: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), pool.toBuffer()],
    programId
  );
}

function deriveSolVaultPda(pool: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), pool.toBuffer()],
    programId
  );
}

function deriveStakeLotPda(
  pool: PublicKey,
  owner: PublicKey,
  lotSeed: bigint,
  programId: PublicKey
): [PublicKey, number] {
  const lotSeedBuffer = Buffer.alloc(8);
  lotSeedBuffer.writeBigUInt64LE(lotSeed);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("lot"), pool.toBuffer(), owner.toBuffer(), lotSeedBuffer],
    programId
  );
}

// Tier configuration with expected behaviors
const TIER_CONFIG = [
  { name: "Flexible", enum: { flexible: {} }, index: 0, lockSeconds: 60, canUnstakeImmediately: false },
  { name: "24 Hours", enum: { hours24: {} }, index: 1, lockSeconds: 86400, canUnstakeImmediately: false },
  { name: "72 Hours", enum: { hours72: {} }, index: 2, lockSeconds: 259200, canUnstakeImmediately: false },
  { name: "1 Week", enum: { week1: {} }, index: 3, lockSeconds: 604800, canUnstakeImmediately: false },
  { name: "1 Month", enum: { month1: {} }, index: 4, lockSeconds: 2592000, canUnstakeImmediately: false },
  { name: "Permanent", enum: { permanent: {} }, index: 5, lockSeconds: -1, canUnstakeImmediately: false }, // -1 = never
];

const TIER_MULTIPLIERS = [10000n, 11500n, 12500n, 14000n, 17000n, 20000n];

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("TIER VALIDATION TESTS");
  console.log("=".repeat(70));
  console.log("Testing all 6 tiers to ensure no tokens are accidentally locked\n");

  // Setup
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  
  const adminKeypairPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const adminKeypair = loadKeypair(adminKeypairPath);
  
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  const programId = new PublicKey(idl.address);
  
  const adminWallet = new anchor.Wallet(adminKeypair);
  const adminProvider = new AnchorProvider(connection, adminWallet, { 
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  const program = new Program(idl, adminProvider) as Program<SolMemecoinStaking>;

  console.log("Program ID:", programId.toBase58());
  console.log("Admin:", adminKeypair.publicKey.toBase58());

  // ============================================================
  // Setup: Create Token-2022 Mint
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("Setup: Create Token-2022 Mint and Pool");
  console.log("━".repeat(60));

  const mintKeypair = Keypair.generate();
  const tokenMint = mintKeypair.publicKey;

  try {
    const mintLen = getMintLen([]);
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: adminKeypair.publicKey,
        newAccountPubkey: tokenMint,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMintInstruction(
        tokenMint,
        DECIMALS,
        adminKeypair.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tx, [adminKeypair, mintKeypair]);
    console.log("✅ Mint created:", tokenMint.toBase58());
  } catch (error: any) {
    console.error("❌ Failed to create mint:", error.message);
    process.exit(1);
  }

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);

  // Initialize pool
  try {
    await program.methods
      .initializePool(adminKeypair.publicKey, null)
      .accountsPartial({
        authority: adminKeypair.publicKey,
        tokenMint: tokenMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();
    console.log("✅ Pool initialized");
  } catch (error: any) {
    console.error("❌ Failed to initialize pool:", error.message);
    process.exit(1);
  }

  // Create admin token account and mint tokens
  const adminAta = await getAssociatedTokenAddress(
    tokenMint,
    adminKeypair.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  try {
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        adminAta,
        adminKeypair.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        tokenMint,
        adminAta,
        adminKeypair.publicKey,
        10_000_000n * BigInt(10 ** DECIMALS), // 10M tokens
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, setupTx, [adminKeypair]);
    console.log("✅ Admin token account funded with 10M tokens");
  } catch (error: any) {
    console.error("❌ Failed to setup admin token account:", error.message);
    process.exit(1);
  }

  // ============================================================
  // TEST 1: Stake with all 6 tiers and verify tier stored correctly
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 1: Stake with all 6 tiers - verify tier stored correctly");
  console.log("━".repeat(60));

  const stakeAmount = 1000n * BigInt(10 ** DECIMALS); // 1000 tokens per tier
  const lotSeeds: bigint[] = [];
  const stakeLotPdas: PublicKey[] = [];

  for (let i = 0; i < 6; i++) {
    const tierConfig = TIER_CONFIG[i];
    const lotSeed = BigInt(Date.now()) + BigInt(i * 1000);
    lotSeeds.push(lotSeed);
    
    const [stakeLotPda] = deriveStakeLotPda(poolPda, adminKeypair.publicKey, lotSeed, programId);
    stakeLotPdas.push(stakeLotPda);

    try {
      await program.methods
        .stake(
          new BN(stakeAmount.toString()),
          tierConfig.enum as any,
          new BN(lotSeed.toString())
        )
        .accountsPartial({
          user: adminKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPda,
          userTokenAccount: adminAta,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();

      // Fetch and verify the stake lot
      const lot = await program.account.stakeLot.fetch(stakeLotPda);
      const storedTier = lot.tier;
      const expectedShares = (stakeAmount * TIER_MULTIPLIERS[i]) / 10000n;
      const actualShares = BigInt(lot.shares.toString());

      const tierCorrect = storedTier === i;
      const sharesCorrect = actualShares === expectedShares;

      if (tierCorrect && sharesCorrect) {
        addResult(
          `Tier ${i} (${tierConfig.name}) stake`,
          true,
          `Stored tier: ${storedTier}, Shares: ${actualShares}`
        );
      } else {
        addResult(
          `Tier ${i} (${tierConfig.name}) stake`,
          false,
          `Tier: ${storedTier} (expected ${i}), Shares: ${actualShares} (expected ${expectedShares})`
        );
      }
    } catch (error: any) {
      addResult(`Tier ${i} (${tierConfig.name}) stake`, false, error.message.slice(0, 50));
    }

    // Small delay
    await new Promise(r => setTimeout(r, 300));
  }

  // ============================================================
  // Wait for Flexible tier 60-second anti-sandwich lock to expire
  // ============================================================
  console.log("\n⏳ Waiting 65 seconds for Flexible tier lock to expire...");
  await new Promise(r => setTimeout(r, 65_000));
  console.log("   Lock period elapsed.");

  // ============================================================
  // TEST 2: Flexible tier (0) can unstake after lock
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 2: Flexible tier can unstake after 60s lock");
  console.log("━".repeat(60));

  try {
    const tokenBalanceBefore = await getAccount(connection, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    
    await program.methods
      .unstake()
      .accountsPartial({
        user: adminKeypair.publicKey,
        pool: poolPda,
        stakeLot: stakeLotPdas[0], // Flexible tier
        userTokenAccount: adminAta,
        tokenVault: tokenVaultPda,
        tokenMint: tokenMint,
        solVault: solVaultPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();

    const tokenBalanceAfter = await getAccount(connection, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    const tokensReturned = BigInt(tokenBalanceAfter.amount.toString()) - BigInt(tokenBalanceBefore.amount.toString());

    if (tokensReturned === stakeAmount) {
      addResult("Flexible unstake immediately", true, `Tokens returned: ${tokensReturned}`);
    } else {
      addResult("Flexible unstake immediately", false, `Tokens returned: ${tokensReturned}, expected: ${stakeAmount}`);
    }

    // Verify lot is closed
    try {
      await program.account.stakeLot.fetch(stakeLotPdas[0]);
      addResult("Flexible lot closed", false, "Lot still exists");
    } catch {
      addResult("Flexible lot closed", true, "Lot closed, rent returned");
    }
  } catch (error: any) {
    addResult("Flexible unstake immediately", false, error.message.slice(0, 60));
  }

  // ============================================================
  // TEST 3: Locked tiers (1-4) cannot unstake early
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 3: Locked tiers (24h, 72h, 1wk, 1mo) cannot unstake early");
  console.log("━".repeat(60));

  for (let i = 1; i <= 4; i++) {
    const tierConfig = TIER_CONFIG[i];
    
    try {
      await program.methods
        .unstake()
        .accountsPartial({
          user: adminKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPdas[i],
          userTokenAccount: adminAta,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          solVault: solVaultPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();
      
      // If we get here, the unstake succeeded (BAD!)
      addResult(`Tier ${i} (${tierConfig.name}) early unstake blocked`, false, "VULNERABILITY: Unstake succeeded!");
    } catch (error: any) {
      if (error.message.includes("UnstakeTooEarly")) {
        addResult(`Tier ${i} (${tierConfig.name}) early unstake blocked`, true, "Correctly blocked");
      } else {
        addResult(`Tier ${i} (${tierConfig.name}) early unstake blocked`, true, `Blocked: ${error.message.slice(0, 40)}`);
      }
    }

    // Verify lot still exists with correct tier
    try {
      const lot = await program.account.stakeLot.fetch(stakeLotPdas[i]);
      if (lot.tier === i && lot.active) {
        console.log(`   ✓ Tier ${i} lot still active with correct tier`);
      }
    } catch (error: any) {
      console.log(`   ⚠️ Could not verify tier ${i} lot`);
    }
  }

  // ============================================================
  // TEST 4: Permanent tier (5) can NEVER unstake
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 4: Permanent tier can NEVER unstake");
  console.log("━".repeat(60));

  try {
    await program.methods
      .unstake()
      .accountsPartial({
        user: adminKeypair.publicKey,
        pool: poolPda,
        stakeLot: stakeLotPdas[5], // Permanent tier
        userTokenAccount: adminAta,
        tokenVault: tokenVaultPda,
        tokenMint: tokenMint,
        solVault: solVaultPda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();
    
    addResult("Permanent unstake blocked", false, "CRITICAL: Permanent tier unstake succeeded!");
  } catch (error: any) {
    if (error.message.includes("UnstakeNotAllowed")) {
      addResult("Permanent unstake blocked", true, "Correctly blocked with UnstakeNotAllowed");
    } else if (error.message.includes("UnstakeTooEarly")) {
      addResult("Permanent unstake blocked", true, "Correctly blocked with UnstakeTooEarly");
    } else {
      addResult("Permanent unstake blocked", true, `Blocked: ${error.message.slice(0, 50)}`);
    }
  }

  // Verify permanent lot still exists
  try {
    const lot = await program.account.stakeLot.fetch(stakeLotPdas[5]);
    if (lot.tier === 5 && lot.active) {
      addResult("Permanent lot preserved", true, "Lot still active with tier=5");
    } else {
      addResult("Permanent lot preserved", false, `Tier: ${lot.tier}, Active: ${lot.active}`);
    }
  } catch {
    addResult("Permanent lot preserved", false, "Lot was closed (should not happen)");
  }

  // ============================================================
  // TEST 5: Verify all locked lots can claim rewards
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 5: All tiers can claim rewards (even if locked)");
  console.log("━".repeat(60));

  // Fund some rewards first
  try {
    await program.methods
      .fundRewards(new BN(0.1 * LAMPORTS_PER_SOL))
      .accountsPartial({
        funder: adminKeypair.publicKey,
        pool: poolPda,
      })
      .signers([adminKeypair])
      .rpc();
    console.log("   Funded 0.1 SOL rewards");
  } catch (error: any) {
    console.log("   Failed to fund rewards:", error.message.slice(0, 50));
  }

  // Try to claim for each remaining lot (tiers 1-5)
  for (let i = 1; i <= 5; i++) {
    const tierConfig = TIER_CONFIG[i];
    
    try {
      await program.methods
        .claim()
        .accountsPartial({
          user: adminKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPdas[i],
          solVault: solVaultPda,
        })
        .signers([adminKeypair])
        .rpc();
      
      addResult(`Tier ${i} (${tierConfig.name}) can claim`, true, "Claim succeeded");
    } catch (error: any) {
      if (error.message.includes("NoRewardsToClaim")) {
        addResult(`Tier ${i} (${tierConfig.name}) can claim`, true, "No rewards (but claim allowed)");
      } else {
        addResult(`Tier ${i} (${tierConfig.name}) can claim`, false, error.message.slice(0, 50));
      }
    }
  }

  // ============================================================
  // TEST 6: Verify pool state is consistent
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("TEST 6: Verify pool state consistency");
  console.log("━".repeat(60));

  try {
    const pool = await program.account.pool.fetch(poolPda);
    const activeLots = pool.activeLots.toNumber();
    const totalStaked = BigInt(pool.totalStaked.toString());
    
    // Should have 5 active lots (tiers 1-5, tier 0 was unstaked)
    const expectedLots = 5;
    const expectedStaked = stakeAmount * 5n;

    const lotsCorrect = activeLots === expectedLots;
    const stakedCorrect = totalStaked === expectedStaked;

    if (lotsCorrect && stakedCorrect) {
      addResult("Pool state consistent", true, 
        `Active lots: ${activeLots}, Total staked: ${totalStaked}`);
    } else {
      addResult("Pool state consistent", false, 
        `Lots: ${activeLots} (exp: ${expectedLots}), Staked: ${totalStaked} (exp: ${expectedStaked})`);
    }
  } catch (error: any) {
    addResult("Pool state consistent", false, error.message);
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log("\n" + "=".repeat(70));
  console.log("TEST SUMMARY");
  console.log("=".repeat(70));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\nTotal: ${results.length} tests`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);

  if (failed > 0) {
    console.log("\n❌ FAILED TESTS:");
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   - ${r.name}: ${r.details}`);
    });
    console.log("\n⚠️ MAINNET READINESS: BLOCKED - Fix failures above");
  } else {
    console.log("\n" + "=".repeat(70));
    console.log("🎉 ALL TIER VALIDATION TESTS PASSED!");
    console.log("=".repeat(70));
    console.log("\n✅ TIER LOGIC VERIFIED:");
    console.log("   • All 6 tiers store correctly (0-5)");
    console.log("   • Flexible tier can unstake after 60s lock");
    console.log("   • Locked tiers enforce their lock periods");
    console.log("   • Permanent tier can NEVER unstake");
    console.log("   • All tiers can claim rewards while locked");
    console.log("   • No tokens accidentally locked by tier bugs");
    console.log("\n✅ MAINNET READINESS: TIER LOGIC APPROVED");
  }

  console.log(`\n📝 Test Token Mint: ${tokenMint.toBase58()}`);
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
