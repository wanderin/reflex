# Security Policy

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly.

### How to Report

**Email:** admin@rflx.fi

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes

### What to Expect

- **Acknowledgment:** Within 48 hours
- **Initial Assessment:** Within 7 days
- **Resolution Timeline:** Depends on severity (critical issues prioritized)

### Scope

This security policy covers:
- The on-chain Solana program (`sol_memecoin_staking`)
- Official TypeScript SDK and scripts
- Official frontend applications

### Out of Scope

- Third-party integrations
- User-created pools or configurations
- Issues already publicly disclosed

## Bug Bounty

We offer bug bounties for valid security reports. Severity and rewards are determined on a case-by-case basis.

| Severity | Example | Potential Reward |
|----------|---------|------------------|
| Critical | Fund theft, unauthorized unstaking | Up to $10,000 |
| High | Reward manipulation, DoS | Up to $5,000 |
| Medium | Information disclosure | Up to $1,000 |
| Low | Minor issues | Recognition |

## Security Measures

### On-Chain Program

- **Upgrade Authority:** Program is upgradeable via Squads multisig only
- **Initialize Config:** Requires program upgrade authority signature
- **Token Extensions:** Dangerous Token-2022 extensions are blocked
- **Freeze Authority:** Tokens with active freeze authority are blocked at pool creation
- **Math Safety:** All arithmetic uses checked operations
- **Permissionless Design:** Pool creation and reward syncing require no special authority
- **Lock Enforcement:** Tier lock durations enforced on-chain

### Operational Security

- **Program upgrade authority is managed via Squads multisig**
- Admin operations require multisig approval
- Regular monitoring of pool states and balances

## Audits

| Auditor | Date | Status |
|---------|------|--------|
| Internal | 2026 | Complete |
| On-chain | Jan 2026 | Verified on Solscan |

## Known Limitations

1. **Authority Model:** Program upgrade authority is managed via Squads multisig for production security.
2. **No Slashing:** Permanent stakes cannot be recovered even in emergencies.
3. **Reward Timing:** Rewards are distributed when `sync_rewards` or `fund_rewards` is called, not continuously.

## Contact

For security concerns: admin@rflx.fi

For general questions: See README.md
