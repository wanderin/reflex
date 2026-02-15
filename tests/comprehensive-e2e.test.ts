/**
 * Comprehensive End-to-End Test
 * 
 * Creates a fresh Token-2022 mint (pump.fun style) and tests:
 * 1. Pool initialization
 * 2. Staking with multiple tiers (admin + testwallet1)
 * 3. Reward funding and distribution math
 * 4. Lock timing enforcement
 * 5. Claiming rewards
 * 6. Unstaking after lock expires
 * 7. Linear scaling verification
 * 8. Lot closing on unstake (rent return)
 * 
 * Run: npx ts-node tests/comprehensive-e2e.test.ts
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
  getMint,
  getAccount,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMintLen,
} from "@solana/spl-token";
import { SolMemecoinStaking } from "../target/types/sol_memecoin_staking";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

// Load IDL
const IDL_PATH = path.join(__dirname, "../target/idl/sol_memecoin_staking.json");

// Test configuration
const DECIMALS = 6; // pump.fun style
const TOTAL_SUPPLY = 1_000_000_000; // 1 billion tokens
const SCALE = BigInt("1000000000000"); // 1e12

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function addResult(name: string, passed: boolean, details: string) {
  results.push({ name, passed, details });
  const status = passed ? "✅" : "❌";
  console.log(`${status} ${name}: ${details}`);
}

function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// Derive PDAs
function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
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

// Calculate expected shares (linear scaling)
function calculateExpectedShares(amount: bigint, tierMultiplier: bigint): bigint {
  return (amount * tierMultiplier) / 10000n;
}

// Tier multipliers
const TIER_MULTIPLIERS = [10000n, 11500n, 12500n, 14000n, 17000n, 20000n];
const TIER_NAMES = ["Flexible", "24 Hours", "72 Hours", "1 Week", "1 Month", "Permanent"];
const TIER_LOCK_SECONDS = [0, 86400, 259200, 604800, 2592000, -1]; // -1 = permanent

// Anchor enum format for tiers
const TIER_ENUMS = [
  { flexible: {} },
  { hours24: {} },
  { hours72: {} },
  { week1: {} },
  { month1: {} },
  { permanent: {} },
];

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("COMPREHENSIVE END-TO-END TEST");
  console.log("=".repeat(70) + "\n");

  // Setup
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  
  const adminKeypairPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const userKeypairPath = process.env.USER_KEYPAIR_PATH || "~/.config/solana/test-user.json";
  
  const adminKeypair = loadKeypair(adminKeypairPath);
  const userKeypair = loadKeypair(userKeypairPath);
  
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  const programId = new PublicKey(idl.address);
  
  const adminWallet = new anchor.Wallet(adminKeypair);
  const adminProvider = new AnchorProvider(connection, adminWallet, { preflightCommitment: "confirmed" });
  const program = new Program(idl, adminProvider) as Program<SolMemecoinStaking>;
  
  const userWallet = new anchor.Wallet(userKeypair);
  const userProvider = new AnchorProvider(connection, userWallet, { preflightCommitment: "confirmed" });
  const userProgram = new Program(idl, userProvider) as Program<SolMemecoinStaking>;

  console.log("Program ID:", programId.toBase58());
  console.log("Admin:", adminKeypair.publicKey.toBase58());
  console.log("User:", userKeypair.publicKey.toBase58());

  // Check balances
  const adminBalance = await connection.getBalance(adminKeypair.publicKey);
  const userBalance = await connection.getBalance(userKeypair.publicKey);
  console.log(`\nAdmin SOL balance: ${adminBalance / LAMPORTS_PER_SOL}`);
  console.log(`User SOL balance: ${userBalance / LAMPORTS_PER_SOL}`);

  if (adminBalance < 0.5 * LAMPORTS_PER_SOL) {
    console.error("Admin needs more SOL!");
    process.exit(1);
  }

  // ============================================================
  // STEP 1: Create Token-2022 Mint (pump.fun style)
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 1: Create Token-2022 Mint");
  console.log("━".repeat(60));

  const mintKeypair = Keypair.generate();
  const tokenMint = mintKeypair.publicKey;
  console.log("New Token Mint:", tokenMint.toBase58());

  try {
    // Create a basic Token-2022 mint (no extensions - simpler and still tests Token-2022 path)
    // Note: pump.fun tokens use MetadataPointer, but basic Token-2022 is sufficient for testing
    const mintLen = getMintLen([]); // 82 bytes for base mint
    const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

    // Build transaction
    const tx = new Transaction().add(
      // Create account
      SystemProgram.createAccount({
        fromPubkey: adminKeypair.publicKey,
        newAccountPubkey: tokenMint,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      // Initialize mint
      createInitializeMintInstruction(
        tokenMint,
        DECIMALS,
        adminKeypair.publicKey,
        null, // no freeze authority (like pump.fun)
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tx, [adminKeypair, mintKeypair]);
    
    const mintInfo = await getMint(connection, tokenMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    addResult("Create Token-2022 mint", true, `Decimals: ${mintInfo.decimals}, Mint: ${tokenMint.toBase58().slice(0,8)}...`);
  } catch (error: any) {
    addResult("Create Token-2022 mint", false, error.message);
    console.error("Failed to create mint, exiting");
    process.exit(1);
  }

  // ============================================================
  // STEP 2: Create token accounts and mint tokens
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 2: Mint tokens to admin and user");
  console.log("━".repeat(60));

  const rawAmount = BigInt(TOTAL_SUPPLY) * BigInt(10 ** DECIMALS);
  const adminTokens = rawAmount / 2n; // 500M to admin
  const userTokens = rawAmount / 2n;  // 500M to user

  try {
    // Create admin token account
    const adminAta = await getAssociatedTokenAddress(
      tokenMint,
      adminKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    
    const userAta = await getAssociatedTokenAddress(
      tokenMint,
      userKeypair.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        adminAta,
        adminKeypair.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        userAta,
        userKeypair.publicKey,
        tokenMint,
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        tokenMint,
        adminAta,
        adminKeypair.publicKey,
        adminTokens,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        tokenMint,
        userAta,
        adminKeypair.publicKey,
        userTokens,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    await sendAndConfirmTransaction(connection, tx, [adminKeypair]);
    
    const adminAccount = await getAccount(connection, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    const userAccount = await getAccount(connection, userAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    
    addResult("Mint tokens", true, `Admin: ${Number(adminAccount.amount) / 10**DECIMALS}M, User: ${Number(userAccount.amount) / 10**DECIMALS}M`);
  } catch (error: any) {
    addResult("Mint tokens", false, error.message);
    process.exit(1);
  }

  // ============================================================
  // STEP 3: Initialize Pool
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 3: Initialize Pool");
  console.log("━".repeat(60));

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);
  const [configPda] = deriveConfigPda(programId);

  try {
    const tx = await program.methods
      .initializePool(adminKeypair.publicKey, null)
      .accountsPartial({
        authority: adminKeypair.publicKey,
        tokenMint: tokenMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([adminKeypair])
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    addResult("Initialize pool", true, `Pool: ${poolPda.toBase58().slice(0,8)}..., TX: ${tx.slice(0,8)}...`);
    
    console.log("   Tier multipliers:", pool.tierMultipliers.map(m => m.toString()).join(", "));
  } catch (error: any) {
    if (error.message.includes("already in use")) {
      addResult("Initialize pool", true, "Pool already exists (reusing)");
    } else {
      addResult("Initialize pool", false, error.message);
      process.exit(1);
    }
  }

  // ============================================================
  // STEP 4: Stake with multiple tiers
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 4: Stake with multiple tiers");
  console.log("━".repeat(60));

  const stakeAmount = 100_000n * BigInt(10 ** DECIMALS); // 100K tokens per stake
  const lotSeeds: { owner: string; seed: bigint; tier: number; pda: PublicKey }[] = [];

  // Admin stakes: Flexible (tier 0) and 24 Hours (tier 1)
  for (const tier of [0, 1]) {
    try {
      const lotSeed = BigInt(Date.now()) + BigInt(tier * 1000);
      const [stakeLotPda] = deriveStakeLotPda(poolPda, adminKeypair.publicKey, lotSeed, programId);
      
      const adminAta = await getAssociatedTokenAddress(
        tokenMint, adminKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      const tx = await program.methods
        .stake(new BN(stakeAmount.toString()), TIER_ENUMS[tier] as any, new BN(lotSeed.toString()))
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

      const lot = await program.account.stakeLot.fetch(stakeLotPda);
      const expectedShares = calculateExpectedShares(stakeAmount, TIER_MULTIPLIERS[tier]);
      const actualShares = BigInt(lot.shares.toString());
      const sharesMatch = actualShares === expectedShares;

      lotSeeds.push({ owner: "admin", seed: lotSeed, tier, pda: stakeLotPda });
      
      addResult(
        `Admin stake ${TIER_NAMES[tier]}`,
        sharesMatch,
        `Amount: ${Number(stakeAmount)/10**DECIMALS}K, Shares: ${actualShares} (expected: ${expectedShares})`
      );
    } catch (error: any) {
      addResult(`Admin stake ${TIER_NAMES[tier]}`, false, error.message);
    }
    
    await new Promise(r => setTimeout(r, 500)); // Small delay between stakes
  }

  // User stakes: 72 Hours (tier 2) and 1 Week (tier 3)
  for (const tier of [2, 3]) {
    try {
      const lotSeed = BigInt(Date.now()) + BigInt(tier * 1000);
      const [stakeLotPda] = deriveStakeLotPda(poolPda, userKeypair.publicKey, lotSeed, programId);
      
      const userAta = await getAssociatedTokenAddress(
        tokenMint, userKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      const tx = await userProgram.methods
        .stake(new BN(stakeAmount.toString()), TIER_ENUMS[tier] as any, new BN(lotSeed.toString()))
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPda,
          userTokenAccount: userAta,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userKeypair])
        .rpc();

      const lot = await program.account.stakeLot.fetch(stakeLotPda);
      const expectedShares = calculateExpectedShares(stakeAmount, TIER_MULTIPLIERS[tier]);
      const actualShares = BigInt(lot.shares.toString());
      const sharesMatch = actualShares === expectedShares;

      lotSeeds.push({ owner: "user", seed: lotSeed, tier, pda: stakeLotPda });
      
      addResult(
        `User stake ${TIER_NAMES[tier]}`,
        sharesMatch,
        `Amount: ${Number(stakeAmount)/10**DECIMALS}K, Shares: ${actualShares} (expected: ${expectedShares})`
      );
    } catch (error: any) {
      addResult(`User stake ${TIER_NAMES[tier]}`, false, error.message);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }

  // ============================================================
  // STEP 5: Verify pool state
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 5: Verify pool state");
  console.log("━".repeat(60));

  try {
    const pool = await program.account.pool.fetch(poolPda);
    const expectedTotalStaked = stakeAmount * 4n; // 4 stakes
    const actualTotalStaked = BigInt(pool.totalStaked.toString());
    
    // Calculate expected total shares
    let expectedTotalShares = 0n;
    for (const tier of [0, 1, 2, 3]) {
      expectedTotalShares += calculateExpectedShares(stakeAmount, TIER_MULTIPLIERS[tier]);
    }
    const actualTotalShares = BigInt(pool.totalShares.toString());

    addResult(
      "Pool total staked",
      actualTotalStaked === expectedTotalStaked,
      `${Number(actualTotalStaked)/10**DECIMALS}K tokens (expected: ${Number(expectedTotalStaked)/10**DECIMALS}K)`
    );
    
    addResult(
      "Pool total shares",
      actualTotalShares === expectedTotalShares,
      `${actualTotalShares} shares (expected: ${expectedTotalShares})`
    );
    
    addResult("Pool active lots", pool.activeLots.toNumber() === 4, `${pool.activeLots} lots (expected: 4)`);
  } catch (error: any) {
    addResult("Verify pool state", false, error.message);
  }

  // ============================================================
  // STEP 6: Fund rewards
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 6: Fund rewards");
  console.log("━".repeat(60));

  const fundAmount = 0.1 * LAMPORTS_PER_SOL; // 0.1 SOL

  try {
    const poolBefore = await program.account.pool.fetch(poolPda);
    const accBefore = BigInt(poolBefore.accSolPerShare.toString());

    const tx = await program.methods
      .fundRewards(new BN(fundAmount))
      .accountsPartial({
        funder: adminKeypair.publicKey,
        pool: poolPda,
      })
      .signers([adminKeypair])
      .rpc();

    const poolAfter = await program.account.pool.fetch(poolPda);
    const accAfter = BigInt(poolAfter.accSolPerShare.toString());
    const totalShares = BigInt(poolAfter.totalShares.toString());
    
    // Verify accumulator math: acc_sol_per_share += (amount * SCALE) / total_shares
    const expectedIncrease = (BigInt(fundAmount) * SCALE) / totalShares;
    const actualIncrease = accAfter - accBefore;
    const accMatch = actualIncrease === expectedIncrease;

    addResult(
      "Fund rewards",
      true,
      `Funded: ${fundAmount / LAMPORTS_PER_SOL} SOL, TX: ${tx.slice(0,8)}...`
    );
    
    addResult(
      "Accumulator math",
      accMatch,
      `Increase: ${actualIncrease} (expected: ${expectedIncrease})`
    );
  } catch (error: any) {
    addResult("Fund rewards", false, error.message);
  }

  // ============================================================
  // STEP 7: Test lock timing (try unstake too early)
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 7: Test lock timing enforcement");
  console.log("━".repeat(60));

  // Try to unstake user's 72-hour stake (tier 2) - should fail
  const lockedLot = lotSeeds.find(l => l.owner === "user" && l.tier === 2);
  if (lockedLot) {
    try {
      const userAta = await getAssociatedTokenAddress(
        tokenMint, userKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      await userProgram.methods
        .unstake()
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: lockedLot.pda,
          userTokenAccount: userAta,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          solVault: solVaultPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([userKeypair])
        .rpc();

      addResult("Lock timing (72h early unstake)", false, "VULNERABILITY: Unstake succeeded before lock expired!");
    } catch (error: any) {
      const isExpectedError = error.message.includes("UnstakeTooEarly") || error.message.includes("lock");
      addResult(
        "Lock timing (72h early unstake)",
        isExpectedError,
        `Correctly blocked: ${error.message.slice(0, 50)}...`
      );
    }
  }

  // ============================================================
  // STEP 8: Claim rewards (wait for 60s anti-sandwich window)
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 8: Claim rewards");
  console.log("━".repeat(60));

  // Flexible tier has a 60-second lock (anti-sandwich). Wait for it.
  console.log("  Waiting 65 seconds for Flexible tier lock to expire...");
  await new Promise(resolve => setTimeout(resolve, 65_000));

  // Claim from admin's flexible stake
  const flexibleLot = lotSeeds.find(l => l.owner === "admin" && l.tier === 0);
  if (flexibleLot) {
    try {
      const balanceBefore = await connection.getBalance(adminKeypair.publicKey);
      
      const lot = await program.account.stakeLot.fetch(flexibleLot.pda);
      const pool = await program.account.pool.fetch(poolPda);
      
      // Calculate expected pending
      const shares = BigInt(lot.shares.toString());
      const accSolPerShare = BigInt(pool.accSolPerShare.toString());
      const rewardDebt = BigInt(lot.rewardDebt.toString());
      const expectedPending = (shares * accSolPerShare / SCALE) - rewardDebt;

      const tx = await program.methods
        .claim()
        .accountsPartial({
          user: adminKeypair.publicKey,
          pool: poolPda,
          stakeLot: flexibleLot.pda,
          solVault: solVaultPda,
        })
        .signers([adminKeypair])
        .rpc();

      const balanceAfter = await connection.getBalance(adminKeypair.publicKey);
      // Account for tx fee (~5000 lamports)
      const received = balanceAfter - balanceBefore + 5000;
      
      addResult(
        "Claim rewards (admin flexible)",
        true,
        `Received: ~${(received / LAMPORTS_PER_SOL).toFixed(6)} SOL (expected: ${Number(expectedPending) / LAMPORTS_PER_SOL})`
      );
    } catch (error: any) {
      addResult("Claim rewards (admin flexible)", false, error.message);
    }
  }

  // ============================================================
  // STEP 9: Unstake flexible tier (should close lot)
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 9: Unstake flexible tier (lot closing)");
  console.log("━".repeat(60));

  if (flexibleLot) {
    try {
      const adminAta = await getAssociatedTokenAddress(
        tokenMint, adminKeypair.publicKey, false, TOKEN_2022_PROGRAM_ID
      );
      
      const balanceBefore = await connection.getBalance(adminKeypair.publicKey);
      const tokensBefore = (await getAccount(connection, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;

      const tx = await program.methods
        .unstake()
        .accountsPartial({
          user: adminKeypair.publicKey,
          pool: poolPda,
          stakeLot: flexibleLot.pda,
          userTokenAccount: adminAta,
          tokenVault: tokenVaultPda,
          tokenMint: tokenMint,
          solVault: solVaultPda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([adminKeypair])
        .rpc();

      const tokensAfter = (await getAccount(connection, adminAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
      const tokensReceived = tokensAfter - tokensBefore;
      
      addResult(
        "Unstake flexible",
        tokensReceived === stakeAmount,
        `Tokens returned: ${Number(tokensReceived)/10**DECIMALS}K`
      );

      // Verify lot is closed
      try {
        await program.account.stakeLot.fetch(flexibleLot.pda);
        addResult("Lot closed on unstake", false, "Lot still exists!");
      } catch {
        addResult("Lot closed on unstake", true, "Lot account closed, rent returned");
      }
    } catch (error: any) {
      addResult("Unstake flexible", false, error.message);
    }
  }

  // ============================================================
  // STEP 10: Verify pool state after unstake
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 10: Verify pool state after unstake");
  console.log("━".repeat(60));

  try {
    const pool = await program.account.pool.fetch(poolPda);
    
    // Should now have 3 active lots
    addResult("Active lots after unstake", pool.activeLots.toNumber() === 3, `${pool.activeLots} lots (expected: 3)`);
    
    // Total staked should be reduced
    const expectedStaked = stakeAmount * 3n;
    const actualStaked = BigInt(pool.totalStaked.toString());
    addResult(
      "Total staked after unstake",
      actualStaked === expectedStaked,
      `${Number(actualStaked)/10**DECIMALS}K tokens`
    );
  } catch (error: any) {
    addResult("Verify pool after unstake", false, error.message);
  }

  // ============================================================
  // STEP 11: Test unauthorized actions
  // ============================================================
  console.log("\n" + "━".repeat(60));
  console.log("STEP 11: Test unauthorized actions");
  console.log("━".repeat(60));

  // User tries to fund rewards (should fail)
  try {
    await userProgram.methods
      .fundRewards(new BN(1000))
      .accountsPartial({
        funder: userKeypair.publicKey,
        pool: poolPda,
      })
      .signers([userKeypair])
      .rpc();

    addResult("User fund rewards", false, "VULNERABILITY: Non-admin could fund!");
  } catch (error: any) {
    addResult("User fund rewards blocked", true, "Correctly rejected");
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
    for (const r of results.filter(r => !r.passed)) {
      console.log(`   - ${r.name}: ${r.details}`);
    }
  }

  console.log("\n📝 Test Token Mint:", tokenMint.toBase58());
  console.log("   (You can use this mint for additional manual testing)");

  if (failed === 0) {
    console.log("\n🎉 ALL TESTS PASSED! Program is functioning correctly.");
  } else {
    console.log("\n⚠️  Some tests failed. Review the issues above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
