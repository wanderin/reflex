/**
 * Common test utilities
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { SolMemecoinStaking } from "../target/types/sol_memecoin_staking";
import * as fs from "fs";
import * as path from "path";
import BN from "bn.js";

// Load IDL
const IDL_PATH = path.join(__dirname, "../target/idl/sol_memecoin_staking.json");

export const SCALE = BigInt("1000000000000"); // 1e12

export interface TestConfig {
  connection: Connection;
  programId: PublicKey;
  program: Program<SolMemecoinStaking>;
  adminKeypair: Keypair;
  userKeypair: Keypair;
  tokenMint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

/**
 * Load a keypair from file
 */
export function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace("~", process.env.HOME || "");
  const secretKey = JSON.parse(fs.readFileSync(expandedPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

/**
 * Initialize test configuration
 */
export async function initTestConfig(): Promise<TestConfig> {
  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");
  
  // Load keypairs
  const adminKeypairPath = process.env.ANCHOR_WALLET || "~/.config/solana/id.json";
  const userKeypairPath = process.env.USER_KEYPAIR_PATH || "~/.config/solana/test-user.json";
  
  const adminKeypair = loadKeypair(adminKeypairPath);
  const userKeypair = loadKeypair(userKeypairPath);
  
  // Load IDL and create program
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  const programId = new PublicKey(idl.address);
  
  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new AnchorProvider(connection, wallet, { preflightCommitment: "confirmed" });
  const program = new Program(idl, provider) as Program<SolMemecoinStaking>;
  
  // Token mint - using the test token on devnet
  const tokenMint = new PublicKey(process.env.TEST_TOKEN_MINT || "9CMdHLu4v7HsDJMegcJ9ByqyfqvdwGXEV25Fabbex68U");
  
  // Detect token program
  let tokenProgram: PublicKey;
  let decimals: number;
  try {
    const mintInfo = await getMint(connection, tokenMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    decimals = mintInfo.decimals;
  } catch {
    const mintInfo = await getMint(connection, tokenMint, "confirmed", TOKEN_PROGRAM_ID);
    tokenProgram = TOKEN_PROGRAM_ID;
    decimals = mintInfo.decimals;
  }
  
  return {
    connection,
    programId,
    program,
    adminKeypair,
    userKeypair,
    tokenMint,
    tokenProgram,
    decimals,
  };
}

/**
 * Derive PDAs
 */
export function deriveConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

export function derivePoolPda(tokenMint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer()],
    programId
  );
}

export function deriveTokenVaultPda(pool: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), pool.toBuffer()],
    programId
  );
}

export function deriveSolVaultPda(pool: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol_vault"), pool.toBuffer()],
    programId
  );
}

export function deriveStakeLotPda(
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

/**
 * Get user's stake lots for a pool
 */
export async function getUserLots(
  program: Program<SolMemecoinStaking>,
  poolPda: PublicKey,
  userPubkey: PublicKey
): Promise<any[]> {
  const allLots = await program.account.stakeLot.all();
  return allLots.filter((lot: any) => 
    lot.account.pool.equals(poolPda) && 
    lot.account.owner.equals(userPubkey) && 
    lot.account.active
  );
}

/**
 * Calculate pending rewards
 */
export function calculatePendingRewards(
  shares: bigint,
  accSolPerShare: bigint,
  rewardDebt: bigint
): bigint {
  const accumulated = (shares * accSolPerShare) / SCALE;
  const pending = accumulated - rewardDebt;
  return pending > 0n ? pending : 0n;
}

/**
 * Format lamports to SOL string
 */
export function formatLamports(lamports: number | bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL`;
}

/**
 * Test result helpers
 */
export function expectError(error: any, expectedCode: string): boolean {
  const errorStr = error.toString();
  return errorStr.includes(expectedCode);
}

export function logTestResult(testName: string, passed: boolean, details?: string) {
  const status = passed ? "✅ PASS" : "❌ FAIL";
  console.log(`${status}: ${testName}`);
  if (details) {
    console.log(`   ${details}`);
  }
}

/**
 * Sleep helper
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Tier definitions
 */
export const StakingTier = {
  Flexible: { flexible: {} },
  Hours24: { hours24: {} },
  Hours72: { hours72: {} },
  Week1: { week1: {} },
  Month1: { month1: {} },
  Permanent: { permanent: {} },
} as const;
