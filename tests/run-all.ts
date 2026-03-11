/**
 * Run All Security Tests
 * 
 * This script runs all security and edge case tests sequentially.
 * 
 * Usage:
 *   npx ts-node tests/run-all.ts
 * 
 * Or run individual test suites:
 *   npx ts-node tests/security/authorization.test.ts
 *   npx ts-node tests/security/math-overflow.test.ts
 *   npx ts-node tests/security/economic-attacks.test.ts
 *   npx ts-node tests/edge-cases.test.ts
 */

import { execSync } from "child_process";
import * as path from "path";

const testDir = __dirname;

const testSuites = [
  {
    name: "Authorization Security Tests",
    file: "security/authorization.test.ts",
  },
  {
    name: "Math & Overflow Tests",
    file: "security/math-overflow.test.ts",
  },
  {
    name: "Economic Attack Tests",
    file: "security/economic-attacks.test.ts",
  },
  {
    name: "Edge Case Tests",
    file: "edge-cases.test.ts",
  },
  {
    name: "Merge Lots & Add To Lot Tests",
    file: "merge-lots.test.ts",
  },
];

async function runAllTests() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║           SOLANA STAKING PROGRAM - SECURITY TESTS          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Environment:");
  console.log(`  RPC: ${process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com"}`);
  console.log(`  Admin: ${process.env.ANCHOR_WALLET || "~/.config/solana/id.json"}`);
  console.log(`  User: ${process.env.USER_KEYPAIR_PATH || "~/.config/solana/test-user.json"}`);
  console.log("");

  const results: { name: string; success: boolean; error?: string }[] = [];

  for (const suite of testSuites) {
    console.log(`\n${"▓".repeat(64)}`);
    console.log(`Running: ${suite.name}`);
    console.log(`${"▓".repeat(64)}`);

    try {
      const testPath = path.join(testDir, suite.file);
      execSync(`npx ts-node "${testPath}"`, {
        stdio: "inherit",
        env: process.env,
        cwd: path.join(testDir, ".."),
      });
      results.push({ name: suite.name, success: true });
    } catch (error: any) {
      results.push({ 
        name: suite.name, 
        success: false, 
        error: error.message 
      });
    }
  }

  // Final summary
  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                    FINAL TEST SUMMARY                      ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log("");

  let allPassed = true;
  for (const result of results) {
    const status = result.success ? "✅ PASSED" : "❌ FAILED";
    console.log(`  ${status}: ${result.name}`);
    if (!result.success) {
      allPassed = false;
    }
  }

  console.log("");
  if (allPassed) {
    console.log("🎉 ALL TEST SUITES PASSED");
    console.log("");
    console.log("Next steps before mainnet:");
    console.log("  1. Get a professional security audit");
    console.log("  2. Set up multisig for admin key");
    console.log("  3. Test with larger token amounts");
    console.log("  4. Monitor first few days of mainnet operation");
  } else {
    console.log("⚠️  SOME TESTS FAILED - DO NOT DEPLOY TO MAINNET");
    console.log("");
    console.log("Review the failed tests above and fix issues before proceeding.");
  }

  process.exit(allPassed ? 0 : 1);
}

runAllTests().catch((error) => {
  console.error("Test runner error:", error);
  process.exit(1);
});
