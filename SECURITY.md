# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@paytrack.dev** with:

1. A clear description of the vulnerability
2. Steps to reproduce
3. The potential impact (data exposure, financial loss, authentication bypass, etc.)
4. Your suggested fix if you have one

You will receive a response within 48 hours. We will keep you informed as we work on a fix and ask that you give us reasonable time before any public disclosure.

## Scope

In scope for this repository:
- Authentication and session management vulnerabilities
- SQL injection or ORM bypass
- Payment processing logic flaws that could allow duplicate payments or incorrect reconciliation
- Stellar transaction verification bypass
- Workspace data isolation failures (one workspace accessing another's data)
- Secret key or credential exposure

Out of scope:
- Vulnerabilities in third-party packages (report to the upstream project)
- Issues that require physical access to the server
- Denial of service via legitimate API usage (rate limiting is in place)

## Security Architecture Summary

For contributors reviewing the codebase:

| Control | Implementation |
|---|---|
| Password hashing | Argon2id, 64MB memory, 3 iterations |
| Session tokens | 15-min JWT access + 7-day HTTP-only refresh |
| Input validation | Zod on all endpoints |
| SQL injection | Prisma parameterised queries — no raw string interpolation |
| Payment idempotency | Unique `idempotencyKey` per transaction, DB unique constraint |
| Stellar verification | Backend independently fetches from Horizon — client data never trusted |
| Workspace isolation | `workspaceId` checked on every resource query |
| Audit logging | All financial operations written to `AuditLog` |

## Known Limitations (MVP)

The following security controls are planned but not yet implemented:

- Email verification enforcement (registered but not enforced at login)
- Two-factor authentication
- IP-based session binding
- Automated dependency vulnerability scanning in CI
- Formal security audit

PayTrack MVP is suitable for testnet use. A professional security audit is required before processing real funds on mainnet.
