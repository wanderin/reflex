/**
 * Merge Lots & Add To Lot Tests
 *
 * Covers the merge_lots and add_to_lot instructions end-to-end on devnet.
 *
 * merge_lots:
 *   1. Happy path: two same-tier lots merge; lot_close is closed and rent returned
 *   2. Pending rewards preserved additively across the merge
 *   3. Later unlock_at is kept when the two lots have different lock expiries
 *   4. Rejects merging lots with different tiers (TierMismatch / 0x1784)
 *   5. Rejects passing the same account for both lot_keep and lot_close
 *
 * add_to_lot:
 *   6. Happy path: tokens added to existing lot; amount, shares, and pool totals increase
 *   7. Pending rewards unchanged after adding tokens (additive-debt invariant)
 *   8. Rejects zero-amount add (InvalidAmount / 0x1775)
 *
 * Prerequisites:
 *   - ANCHOR_PROVIDER_URL pointing to devnet (or set in env)
 *   - ANCHOR_WALLET  — admin keypair path (default ~/.config/solana/id.json)
 *   - USER_KEYPAIR_PATH — user keypair path (default ~/.config/solana/test-user.json)
 *   - TEST_TOKEN_MINT  — devnet token mint with an existing pool
 *   - User wallet must hold at least (SMALL_STAKE * 4 + ADD_AMOUNT * 2) tokens
 *   - Admin wallet must hold at least 0.05 SOL for reward funding + fees
 *
 * Run:
 *   npx ts-node tests/merge-lots.test.ts
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
  calculatePendingRewards,
  logTestResult,
  formatLamports,
  StakingTier,
  sleep,
} from "./common";

// Token amounts (in whole tokens; multiplied by decimals before use)
const SMALL_STAKE = 50;
const ADD_AMOUNT = 25;
// SOL to fund rewards between tests so there are non-zero pending rewards to verify
const FUND_SOL = 0.005;

// ── helpers ────────────────────────────────────────────────────────────────

/** Returns true if the error string contains any of the provided needles. */
function errContains(err: any, ...needles: string[]): boolean {
  const s = err?.toString() ?? "";
  return needles.some((n) => s.includes(n));
}

/** Returns true if the on-chain account at `addr` no longer exists. */
async function accountGone(
  program: anchor.Program<any>,
  accountType: "stakeLot",
  addr: PublicKey
): Promise<boolean> {
  try {
    await program.account[accountType].fetch(addr);
    return false;
  } catch {
    return true;
  }
}

// ── main ───────────────────────────────────────────────────────────────────

async function runMergeLotsTests() {
  console.log("\n" + "=".repeat(60));
  console.log("MERGE LOTS & ADD TO LOT TESTS");
  console.log("=".repeat(60) + "\n");

  const config = await initTestConfig();
  const {
    program,
    programId,
    adminKeypair,
    userKeypair,
    tokenMint,
    tokenProgram,
    decimals,
    connection,
  } = config;

  console.log("Configuration:");
  console.log(`  Program ID : ${programId.toBase58()}`);
  console.log(`  Token Mint : ${tokenMint.toBase58()}`);
  console.log(`  Decimals   : ${decimals}`);
  console.log(`  User       : ${userKeypair.publicKey.toBase58()}`);
  console.log(`  Admin      : ${adminKeypair.publicKey.toBase58()}`);
  console.log("");

  const [poolPda] = derivePoolPda(tokenMint, programId);
  const [solVaultPda] = deriveSolVaultPda(poolPda, programId);
  const [tokenVaultPda] = deriveTokenVaultPda(poolPda, programId);

  const userTokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    userKeypair.publicKey,
    false,
    tokenProgram
  );

  // Verify the user has enough tokens to run all tests
  let userTokenBalance = 0n;
  try {
    const acct = await getAccount(connection, userTokenAccount, "confirmed", tokenProgram);
    userTokenBalance = acct.amount;
  } catch {
    console.error("  User has no token account. Transfer tokens before running.");
    process.exit(1);
  }

  // We stake SMALL_STAKE tokens in tests 1-5 (5 lots × SMALL_STAKE) and
  // ADD_AMOUNT in tests 6-8 (2 lots × ADD_AMOUNT). Use a generous ceiling.
  const neededTokens = BigInt((SMALL_STAKE * 8 + ADD_AMOUNT * 2) * 10 ** decimals);
  if (userTokenBalance < neededTokens) {
    console.error(
      `  User has ${Number(userTokenBalance) / 10 ** decimals} tokens; ` +
        `need at least ${Number(neededTokens) / 10 ** decimals}. ` +
        `Transfer more tokens and retry.`
    );
    process.exit(1);
  }

  // Shared user-signed program instance
  const userWallet = new anchor.Wallet(userKeypair);
  const userProvider = new anchor.AnchorProvider(connection, userWallet, {
    preflightCommitment: "confirmed",
  });
  const userProgram = new anchor.Program(program.idl, userProvider) as typeof program;

  let pass = 0;
  let fail = 0;

  // Stake helper — reduces repetition across tests
  async function stake(
    signerProgram: typeof program,
    signerKeypair: Keypair,
    stakeLotPda: PublicKey,
    lotSeed: bigint,
    amount: number,
    tier: (typeof StakingTier)[keyof typeof StakingTier]
  ) {
    await signerProgram.methods
      .stake(new BN(amount * 10 ** decimals), tier as any, new BN(lotSeed.toString()))
      .accountsPartial({
        user: signerKeypair.publicKey,
        pool: poolPda,
        stakeLot: stakeLotPda,
        userTokenAccount,
        tokenVault: tokenVaultPda,
        tokenMint,
        tokenProgram,
      })
      .signers([signerKeypair])
      .rpc();
    await sleep(1500);
  }

  // Unstake helper — best-effort cleanup; ignores lock errors
  async function unstake(stakeLotPda: PublicKey) {
    try {
      await userProgram.methods
        .unstake()
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: stakeLotPda,
          tokenVault: tokenVaultPda,
          userTokenAccount,
          tokenMint,
          tokenProgram,
          solVault: solVaultPda,
        })
        .signers([userKeypair])
        .rpc();
    } catch {
      // Locked lots cannot be unstaked; silently ignore
    }
  }

  // Fund-rewards helper — skips if admin is low on SOL
  async function fundRewards() {
    const adminBal = await connection.getBalance(adminKeypair.publicKey);
    if (adminBal < (FUND_SOL + 0.01) * LAMPORTS_PER_SOL) return;
    await program.methods
      .fundRewards(new BN(FUND_SOL * LAMPORTS_PER_SOL))
      .accountsPartial({ funder: adminKeypair.publicKey, pool: poolPda })
      .signers([adminKeypair])
      .rpc();
    await sleep(1500);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: merge_lots happy path
  // Two flexible lots are created and merged.  Verify:
  //   - lot_keep absorbs all amount, shares, and reward_debt
  //   - lot_close account is closed (rent returned to user)
  //   - pool.active_lots decrements by 1
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 1: merge_lots happy path ---");
  try {
    const seedA = BigInt(Date.now());
    const seedB = seedA + 1n;
    const [lotA] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedA, programId);
    const [lotB] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedB, programId);

    await stake(userProgram, userKeypair, lotA, seedA, SMALL_STAKE, StakingTier.Flexible);
    await stake(userProgram, userKeypair, lotB, seedB, SMALL_STAKE, StakingTier.Flexible);

    const keepBefore = await program.account.stakeLot.fetch(lotA);
    const closeBefore = await program.account.stakeLot.fetch(lotB);
    const poolBefore = await program.account.pool.fetch(poolPda);
    const userSolBefore = await connection.getBalance(userKeypair.publicKey);

    const tx = await userProgram.methods
      .mergeLots()
      .accountsPartial({
        user: userKeypair.publicKey,
        pool: poolPda,
        lotKeep: lotA,
        lotClose: lotB,
      })
      .signers([userKeypair])
      .rpc();

    console.log(`   TX: ${tx}`);
    console.log(`   View: https://solscan.io/tx/${tx}?cluster=devnet`);
    await sleep(1500);

    const keepAfter = await program.account.stakeLot.fetch(lotA);
    const poolAfter = await program.account.pool.fetch(poolPda);
    const userSolAfter = await connection.getBalance(userKeypair.publicKey);

    const amountOk = keepAfter.amount.eq(keepBefore.amount.add(closeBefore.amount));
    const sharesOk = keepAfter.shares.eq(keepBefore.shares.add(closeBefore.shares));
    const debtOk = keepAfter.rewardDebt.eq(keepBefore.rewardDebt.add(closeBefore.rewardDebt));
    const lotsDecremented = poolAfter.activeLots === poolBefore.activeLots - 1;
    const lotCloseGone = await accountGone(program, "stakeLot", lotB);
    // Rent recovery: user SOL should be net-positive (rent > tx fee)
    const rentRecovered = userSolAfter > userSolBefore - 5_000;

    const ok = amountOk && sharesOk && debtOk && lotsDecremented && lotCloseGone && rentRecovered;
    logTestResult(
      "merge_lots happy path",
      ok,
      `amount=${amountOk} shares=${sharesOk} debt=${debtOk} lots_decremented=${lotsDecremented} lot_close_gone=${lotCloseGone} rent_recovered=${rentRecovered}`
    );
    ok ? pass++ : fail++;

    // Leave lot_keep open for potential follow-on tests; clean up on success
    await unstake(lotA);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("merge_lots happy path", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: merge_lots preserves pending rewards (additive-debt invariant)
  // Stake two lots, fund rewards, then merge.
  // pending(keep) + pending(close) must equal pending(merged) within 1 lamport.
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 2: merge_lots preserves pending rewards ---");
  try {
    const seedC = BigInt(Date.now());
    const seedD = seedC + 1n;
    const [lotC] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedC, programId);
    const [lotD] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedD, programId);

    await stake(userProgram, userKeypair, lotC, seedC, SMALL_STAKE, StakingTier.Flexible);
    await stake(userProgram, userKeypair, lotD, seedD, SMALL_STAKE, StakingTier.Flexible);

    // Fund rewards so pending rewards are non-zero before merge
    await fundRewards();

    const keepBefore = await program.account.stakeLot.fetch(lotC);
    const closeBefore = await program.account.stakeLot.fetch(lotD);
    const poolSnap = await program.account.pool.fetch(poolPda);

    const pendingA = calculatePendingRewards(
      BigInt(keepBefore.shares.toString()),
      BigInt(poolSnap.accSolPerShare.toString()),
      BigInt(keepBefore.rewardDebt.toString())
    );
    const pendingB = calculatePendingRewards(
      BigInt(closeBefore.shares.toString()),
      BigInt(poolSnap.accSolPerShare.toString()),
      BigInt(closeBefore.rewardDebt.toString())
    );
    const expectedTotal = pendingA + pendingB;

    await userProgram.methods
      .mergeLots()
      .accountsPartial({
        user: userKeypair.publicKey,
        pool: poolPda,
        lotKeep: lotC,
        lotClose: lotD,
      })
      .signers([userKeypair])
      .rpc();
    await sleep(1500);

    const keepAfter = await program.account.stakeLot.fetch(lotC);
    const poolAfter = await program.account.pool.fetch(poolPda);
    const pendingAfter = calculatePendingRewards(
      BigInt(keepAfter.shares.toString()),
      BigInt(poolAfter.accSolPerShare.toString()),
      BigInt(keepAfter.rewardDebt.toString())
    );

    // Allow 1-lamport rounding tolerance
    const diff =
      pendingAfter >= expectedTotal
        ? pendingAfter - expectedTotal
        : expectedTotal - pendingAfter;
    const ok = diff <= 1n;

    logTestResult(
      "merge_lots preserves pending rewards",
      ok,
      `A=${formatLamports(pendingA)} B=${formatLamports(pendingB)} ` +
        `expected=${formatLamports(expectedTotal)} got=${formatLamports(pendingAfter)} diff=${diff}`
    );
    ok ? pass++ : fail++;

    await unstake(lotC);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("merge_lots preserves pending rewards", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: merge_lots keeps the later unlock_at
  // Both lots use Hours24 tier (non-zero lock).  Because they're staked at
  // slightly different wall-clock times their unlock_at may differ by a
  // second.  The merged lot must carry the maximum of the two values.
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 3: merge_lots keeps later unlock_at ---");
  try {
    const seedE = BigInt(Date.now());
    const seedF = seedE + 1n;
    const [lotE] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedE, programId);
    const [lotF] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedF, programId);

    // Stake both with Hours24 so unlock times are near-identical but potentially offset
    await stake(userProgram, userKeypair, lotE, seedE, SMALL_STAKE, StakingTier.Hours24);
    await stake(userProgram, userKeypair, lotF, seedF, SMALL_STAKE, StakingTier.Hours24);

    const lotEData = await program.account.stakeLot.fetch(lotE);
    const lotFData = await program.account.stakeLot.fetch(lotF);
    const expectedUnlock = Math.max(
      lotEData.unlockAt.toNumber(),
      lotFData.unlockAt.toNumber()
    );

    await userProgram.methods
      .mergeLots()
      .accountsPartial({
        user: userKeypair.publicKey,
        pool: poolPda,
        lotKeep: lotE,
        lotClose: lotF,
      })
      .signers([userKeypair])
      .rpc();
    await sleep(1500);

    const merged = await program.account.stakeLot.fetch(lotE);
    const ok = merged.unlockAt.toNumber() === expectedUnlock;

    logTestResult(
      "merge_lots keeps later unlock_at",
      ok,
      `E=${lotEData.unlockAt.toNumber()} F=${lotFData.unlockAt.toNumber()} ` +
        `merged=${merged.unlockAt.toNumber()} expected=${expectedUnlock}`
    );
    ok ? pass++ : fail++;
    // Hours24 lots are locked; leave them — they'll expire on their own
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("merge_lots keeps later unlock_at", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: merge_lots rejects different tiers (TierMismatch, 0x1784)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 4: merge_lots rejects different tiers (TierMismatch) ---");
  try {
    const seedG = BigInt(Date.now());
    const seedH = seedG + 1n;
    const [lotFlex] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedG, programId);
    const [lotH24] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedH, programId);

    await stake(userProgram, userKeypair, lotFlex, seedG, SMALL_STAKE, StakingTier.Flexible);
    await stake(userProgram, userKeypair, lotH24, seedH, SMALL_STAKE, StakingTier.Hours24);

    let rejected = false;
    try {
      await userProgram.methods
        .mergeLots()
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          lotKeep: lotFlex,
          lotClose: lotH24,
        })
        .signers([userKeypair])
        .rpc();
    } catch (err: any) {
      // Anchor surfaces custom errors as "0x<hex>" in the message
      rejected = errContains(err, "TierMismatch", "0x1784");
    }

    logTestResult("merge_lots rejects different tiers", rejected);
    rejected ? pass++ : fail++;

    // Clean up the flexible lot; Hours24 stays locked
    await unstake(lotFlex);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("merge_lots rejects different tiers", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 5: merge_lots rejects passing the same lot for both accounts
  // The program constraint `lot_keep.key() != lot_close.key()` (InvalidAmount)
  // fires before any state mutation.  Anchor may also reject at the account
  // layer due to aliased mutable borrows — either way, the call must fail.
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 5: merge_lots rejects same account for keep and close ---");
  try {
    const seedI = BigInt(Date.now());
    const [selfLot] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedI, programId);

    await stake(userProgram, userKeypair, selfLot, seedI, SMALL_STAKE, StakingTier.Flexible);

    let rejected = false;
    try {
      await userProgram.methods
        .mergeLots()
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          lotKeep: selfLot,
          lotClose: selfLot,
        })
        .signers([userKeypair])
        .rpc();
    } catch {
      // Any error is acceptable here — the instruction must not succeed
      rejected = true;
    }

    logTestResult("merge_lots rejects same account for both", rejected);
    rejected ? pass++ : fail++;

    await unstake(selfLot);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("merge_lots rejects same account for both", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 6: add_to_lot happy path
  // Stake a lot, then add more tokens.  Verify that:
  //   - lot.amount and lot.shares increase
  //   - pool.total_staked and pool.total_shares increase correspondingly
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 6: add_to_lot happy path ---");
  try {
    const seedJ = BigInt(Date.now());
    const [addLot] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedJ, programId);

    await stake(userProgram, userKeypair, addLot, seedJ, SMALL_STAKE, StakingTier.Flexible);

    const lotBefore = await program.account.stakeLot.fetch(addLot);
    const poolBefore = await program.account.pool.fetch(poolPda);

    const tx = await userProgram.methods
      .addToLot(new BN(ADD_AMOUNT * 10 ** decimals))
      .accountsPartial({
        user: userKeypair.publicKey,
        pool: poolPda,
        stakeLot: addLot,
        userTokenAccount,
        tokenVault: tokenVaultPda,
        tokenMint,
        tokenProgram,
      })
      .signers([userKeypair])
      .rpc();

    console.log(`   TX: ${tx}`);
    console.log(`   View: https://solscan.io/tx/${tx}?cluster=devnet`);
    await sleep(1500);

    const lotAfter = await program.account.stakeLot.fetch(addLot);
    const poolAfter = await program.account.pool.fetch(poolPda);

    const amountGrew = lotAfter.amount.gt(lotBefore.amount);
    const sharesGrew = lotAfter.shares.gt(lotBefore.shares);
    const poolStakedGrew = poolAfter.totalStaked.gt(poolBefore.totalStaked);
    const poolSharesGrew = poolAfter.totalShares.gt(poolBefore.totalShares);

    const ok = amountGrew && sharesGrew && poolStakedGrew && poolSharesGrew;
    logTestResult(
      "add_to_lot happy path",
      ok,
      `amount ${lotBefore.amount}→${lotAfter.amount} shares grew=${sharesGrew} ` +
        `pool_staked grew=${poolStakedGrew} pool_shares grew=${poolSharesGrew}`
    );
    ok ? pass++ : fail++;

    await unstake(addLot);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("add_to_lot happy path", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 7: add_to_lot preserves pending rewards (additive-debt invariant)
  // Fund rewards after staking, then call add_to_lot.  Pending rewards must
  // remain identical (within 1 lamport) because the new shares' debt is set
  // to exactly new_shares * acc / SCALE.
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 7: add_to_lot preserves pending rewards ---");
  try {
    const seedK = BigInt(Date.now());
    const [rewardLot] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedK, programId);

    await stake(userProgram, userKeypair, rewardLot, seedK, SMALL_STAKE, StakingTier.Flexible);

    // Ensure there is something pending before the add
    await fundRewards();

    const lotBefore = await program.account.stakeLot.fetch(rewardLot);
    const poolSnap = await program.account.pool.fetch(poolPda);
    const pendingBefore = calculatePendingRewards(
      BigInt(lotBefore.shares.toString()),
      BigInt(poolSnap.accSolPerShare.toString()),
      BigInt(lotBefore.rewardDebt.toString())
    );

    await userProgram.methods
      .addToLot(new BN(ADD_AMOUNT * 10 ** decimals))
      .accountsPartial({
        user: userKeypair.publicKey,
        pool: poolPda,
        stakeLot: rewardLot,
        userTokenAccount,
        tokenVault: tokenVaultPda,
        tokenMint,
        tokenProgram,
      })
      .signers([userKeypair])
      .rpc();
    await sleep(1500);

    const lotAfter = await program.account.stakeLot.fetch(rewardLot);
    const poolAfter = await program.account.pool.fetch(poolPda);
    const pendingAfter = calculatePendingRewards(
      BigInt(lotAfter.shares.toString()),
      BigInt(poolAfter.accSolPerShare.toString()),
      BigInt(lotAfter.rewardDebt.toString())
    );

    const diff =
      pendingAfter >= pendingBefore
        ? pendingAfter - pendingBefore
        : pendingBefore - pendingAfter;
    const ok = diff <= 1n;

    logTestResult(
      "add_to_lot preserves pending rewards",
      ok,
      `before=${formatLamports(pendingBefore)} after=${formatLamports(pendingAfter)} diff=${diff}`
    );
    ok ? pass++ : fail++;

    await unstake(rewardLot);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("add_to_lot preserves pending rewards", false, err.message);
    fail++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 8: add_to_lot rejects zero amount (InvalidAmount, 0x1775)
  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- Test 8: add_to_lot rejects zero amount (InvalidAmount) ---");
  try {
    const seedL = BigInt(Date.now());
    const [zeroLot] = deriveStakeLotPda(poolPda, userKeypair.publicKey, seedL, programId);

    await stake(userProgram, userKeypair, zeroLot, seedL, SMALL_STAKE, StakingTier.Flexible);

    let rejected = false;
    try {
      await userProgram.methods
        .addToLot(new BN(0))
        .accountsPartial({
          user: userKeypair.publicKey,
          pool: poolPda,
          stakeLot: zeroLot,
          userTokenAccount,
          tokenVault: tokenVaultPda,
          tokenMint,
          tokenProgram,
        })
        .signers([userKeypair])
        .rpc();
    } catch (err: any) {
      rejected = errContains(err, "InvalidAmount", "0x1775");
    }

    logTestResult("add_to_lot rejects zero amount", rejected);
    rejected ? pass++ : fail++;

    await unstake(zeroLot);
  } catch (err: any) {
    console.log(`   Error: ${err.message}`);
    logTestResult("add_to_lot rejects zero amount", false, err.message);
    fail++;
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log(`RESULTS: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
  console.log("=".repeat(60) + "\n");

  process.exit(fail > 0 ? 1 : 0);
}

runMergeLotsTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
