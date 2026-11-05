# PayTrack — Technical Architecture Document

## 1. Product Overview

PayTrack is a smart payment and invoice reconciliation platform for businesses, freelancers, and merchants. It simplifies invoice generation, payment receipt, transaction detection, payment-to-invoice matching, receipt issuance, and financial tracking using both traditional database records and Stellar blockchain verification.

---

## 2. Repository Structure (Multi-Repo)

```
PayTrack/                          ← Local parent directory (not a Git repo)
├── paytrack-frontend/             ← React + TypeScript + Vite SPA
├── paytrack-backend/              ← Node.js + Express + Prisma API server
└── paytrack-blockchain/           ← Rust + Soroban smart contracts
```

Each repository has its own `.git`, `package.json` / `Cargo.toml`, and independent CI/CD.

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Browser                           │
│                    paytrack-frontend (SPA)                      │
│         React + TypeScript + Vite + Tailwind + shadcn/ui        │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTPS REST API (JSON)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                   paytrack-backend (API Server)                 │
│              Node.js + Express + TypeScript + Prisma            │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Auth       │  │  Invoice     │  │  Payment             │   │
│  │  Service    │  │  Service     │  │  Reconciliation      │   │
│  └─────────────┘  └──────────────┘  │  Engine              │   │
│  ┌─────────────┐  ┌──────────────┐  └──────────────────────┘   │
│  │  Customer   │  │  Reports     │  ┌──────────────────────┐   │
│  │  Service    │  │  Service     │  │  Transaction         │   │
│  └─────────────┘  └──────────────┘  │  Monitor (Worker)    │   │
│                                     └──────────────────────┘   │
└──────┬──────────────────────────────────────┬───────────────────┘
       │                                      │
       ▼                                      ▼
┌─────────────┐                   ┌───────────────────────┐
│ PostgreSQL  │                   │   Stellar Network     │
│ (Prisma ORM)│                   │   (Horizon API)       │
│             │                   │                       │
│ - Users     │                   │  - Transaction verify │
│ - Invoices  │                   │  - Account monitor    │
│ - Payments  │                   │  - Asset verification │
│ - Customers │                   │  - USDC on testnet    │
└─────────────┘                   └───────────────────────┘
                                            │
                                            ▼
                                 ┌───────────────────────┐
                                 │  Soroban Contracts    │
                                 │  (Phase 7 - optional) │
                                 │  paytrack-blockchain  │
                                 └───────────────────────┘
```

---

## 4. Data Flow: Core Payment Reconciliation

```
1. Business creates Invoice (status: PENDING)
   → Stored in PostgreSQL
   → Payment link generated

2. Customer receives payment link / invoice
   → Sees amount due in USDC on Stellar

3. Customer sends USDC payment on Stellar
   → Transaction lands on Stellar testnet/mainnet

4. Transaction Monitor (backend worker) detects transaction
   → Polls or streams Horizon API for new operations
   → Finds payment matching watched Stellar address

5. Backend verifies transaction:
   a. Fetch transaction from Horizon
   b. Verify destination address matches workspace wallet
   c. Verify asset = USDC (correct issuer)
   d. Verify amount
   e. Check transaction finality (ledger closed)
   f. Check for duplicate (idempotency via tx hash)

6. Reconciliation Engine matches payment to invoice:
   a. Look up invoice by memo / payment link / amount
   b. Determine match confidence
   c. Handle exact / partial / over payment
   d. Update invoice status
   e. Create Payment record
   f. Create BlockchainTransaction record
   g. Create PaymentReconciliation record

7. Dashboard updates
   → Business sees paid invoice
   → Receipt available for download
```

---

## 5. Database Entity Relationships

```
User ──< WorkspaceMember >── Workspace
                                │
              ┌─────────────────┼──────────────────┐
              │                 │                  │
           Customer          Invoice          StellarWallet
              │                 │
              └────────────────>│
                            InvoiceItem (1..*)
                                │
                             Payment (0..*)
                                │
                    BlockchainTransaction (1)
                                │
                   PaymentReconciliation (1)

Workspace ──< PaymentLink
Workspace ──< AuditLog
Workspace ──< Notification
User ──< Notification
```

---

## 6. Authentication Architecture

- **Strategy**: Short-lived JWT access tokens (15 min) + HTTP-only refresh tokens (7 days)
- **Password hashing**: Argon2id
- **Session storage**: Refresh token stored in HTTP-only Secure cookie
- **RBAC Roles**: OWNER, ADMIN, ACCOUNTANT, VIEWER
- **Workspace isolation**: All queries scoped to `workspaceId` from authenticated session

---

## 7. Stellar Integration

- **Network**: Testnet in development, mainnet via env config
- **Asset**: USDC — verified issuer address per Stellar ecosystem documentation
- **Monitoring**: Backend polling worker (30s interval) + SSE for real-time UI updates
- **Verification**: Every payment independently verified via Horizon API before acceptance
- **Key safety**: Never store private keys; users register public addresses only

---

## 8. Security Architecture

- Input validation: Zod on all API endpoints
- SQL injection prevention: Prisma parameterized queries
- XSS protection: Content-Security-Policy headers
- CSRF: SameSite=Strict cookies + Origin validation
- Rate limiting: express-rate-limit on auth endpoints
- Audit logging: All financial operations logged
- Data isolation: Workspace-scoped middleware on all resource endpoints
- Secrets: dotenv + never committed to Git

---

## 9. Technology Versions (Target)

| Package | Version |
|---------|---------|
| React | 18.x |
| TypeScript | 5.x |
| Vite | 5.x |
| Tailwind CSS | 3.x |
| Node.js | 20.x LTS |
| Express | 4.x |
| Prisma | 5.x |
| PostgreSQL | 16.x |
| Stellar SDK | 12.x |
| Zod | 3.x |
| Vitest | 1.x |

---

## 10. MVP Scope

**In scope for MVP:**
- User registration, login, workspace creation
- Customer management
- Invoice CRUD with line items
- Invoice PDF generation
- Stellar testnet payment receiving
- Transaction verification via Horizon
- Payment-to-invoice reconciliation
- Duplicate payment prevention
- Dashboard with real backend data
- Basic reports

**Deferred post-MVP:**
- Soroban escrow contracts
- Mainnet deployment
- Multi-currency beyond USDC
- Advanced analytics
- Email notifications
- Two-factor authentication
