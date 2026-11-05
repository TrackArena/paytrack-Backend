# paytrack-backend

REST API server for the PayTrack payment reconciliation platform.

Built with Node.js, Express, TypeScript, PostgreSQL (Prisma ORM), and the Stellar SDK.

## Architecture

```
src/
├── app.ts                  Express app (middleware, routes)
├── index.ts                Server entry point + transaction monitor
├── lib/
│   ├── prisma.ts           Prisma client singleton
│   ├── logger.ts           Structured JSON logger
│   ├── errors.ts           Typed application errors
│   └── response.ts         Consistent API response helpers
├── middleware/
│   ├── authenticate.ts     JWT auth + workspace RBAC
│   ├── validate.ts         Zod request validation
│   ├── errorHandler.ts     Centralised error handler
│   └── notFoundHandler.ts
├── routes/
│   ├── auth.routes.ts
│   ├── workspace.routes.ts
│   ├── dashboard.routes.ts
│   ├── customer.routes.ts
│   ├── invoice.routes.ts
│   ├── payment.routes.ts
│   ├── wallet.routes.ts
│   ├── paymentLink.routes.ts
│   └── report.routes.ts
├── services/
│   ├── auth.service.ts         Argon2id hashing, JWT, refresh tokens
│   ├── payment/
│   │   └── reconciliation.engine.ts   Core payment matching logic
│   └── stellar/
│       ├── stellar.service.ts         Horizon API client
│       └── transactionMonitor.ts      Background polling worker
└── tests/
    ├── setup.ts
    ├── auth.test.ts
    ├── reconciliation.test.ts
    └── stellar.test.ts
```

## Requirements

- Node.js 20+
- PostgreSQL 16+
- npm 9+

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your database credentials and secrets

# 3. Generate Prisma client
npm run db:generate

# 4. Run migrations
npm run db:migrate

# 5. Seed development data
npm run db:seed

# 6. Start dev server
npm run dev
```

The API runs on `http://localhost:3001` by default.

## Environment Variables

See `.env.example` for all required and optional variables.

Key variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Min 64-char secret for access tokens |
| `JWT_REFRESH_SECRET` | Min 64-char secret for refresh tokens |
| `STELLAR_NETWORK` | `testnet` or `mainnet` |
| `STELLAR_USDC_ISSUER_TESTNET` | Circle's official testnet USDC issuer |
| `FRONTEND_URL` | Allowed CORS origin |

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/auth/register` | Register user + workspace |
| POST | `/api/v1/auth/login` | Login |
| POST | `/api/v1/auth/logout` | Logout |
| POST | `/api/v1/auth/refresh` | Refresh access token |
| GET  | `/api/v1/auth/me` | Current user profile |

### Dashboard
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/dashboard/:workspaceId/overview` | KPI metrics |
| GET | `/api/v1/dashboard/:workspaceId/revenue` | Daily revenue chart data |
| GET | `/api/v1/dashboard/:workspaceId/activity` | Activity feed |

### Customers
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/customers` | List customers |
| POST | `/api/v1/customers` | Create customer |
| GET | `/api/v1/customers/:id` | Get customer |
| PATCH | `/api/v1/customers/:id` | Update customer |
| DELETE | `/api/v1/customers/:id` | Soft-delete customer |

### Invoices
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/invoices` | List invoices |
| POST | `/api/v1/invoices` | Create invoice |
| GET | `/api/v1/invoices/:id` | Get invoice |
| GET | `/api/v1/invoices/public/:token` | Public invoice (no auth) |
| PATCH | `/api/v1/invoices/:id` | Update draft invoice |
| POST | `/api/v1/invoices/:id/send` | Send invoice (DRAFT→PENDING) |
| POST | `/api/v1/invoices/:id/cancel` | Cancel invoice |
| DELETE | `/api/v1/invoices/:id` | Delete draft invoice |

### Payments
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/payments` | List payments |
| GET | `/api/v1/payments/:id` | Get payment |
| POST | `/api/v1/payments/verify` | Verify Stellar tx + reconcile |
| POST | `/api/v1/payments/reconcile` | Manual reconciliation |

### Wallets
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/wallets/connect` | Connect Stellar wallet |
| GET | `/api/v1/wallets` | List wallets |
| GET | `/api/v1/wallets/:id` | Get wallet |
| GET | `/api/v1/wallets/:id/transactions` | Wallet transaction history |
| DELETE | `/api/v1/wallets/:id` | Disconnect wallet |

### Reports
| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/reports/revenue` | Revenue summary |
| GET | `/api/v1/reports/invoices` | Invoice summary |
| GET | `/api/v1/reports/transactions` | Transaction list |

### Payment Links
| Method | Path | Description |
|---|---|---|
| POST | `/api/v1/payment-links` | Create payment link |
| GET | `/api/v1/payment-links/:token` | Get link (public) |

## Running Tests

```bash
npm test
```

Tests use Vitest. Unit tests mock Prisma and Stellar SDK. Integration tests (auth) require a running test database.

## Database

```bash
npm run db:migrate       # Apply migrations
npm run db:seed          # Seed development data
npm run db:studio        # Open Prisma Studio
npm run db:reset         # Reset and re-migrate (dev only)
```

Demo credentials after seeding: `demo@paytrack.dev` / `Password123!`

## Stellar Integration

- Uses `@stellar/stellar-sdk` v12
- Testnet by default (`STELLAR_NETWORK=testnet`)
- USDC issuer addresses are verified from Circle's official documentation
- Never stores private keys — public addresses only
- Transaction monitor polls Horizon every 30 seconds for new payments

## Security Notes

- Passwords hashed with Argon2id (64MB memory, 3 iterations)
- JWTs: 15-minute access tokens + 7-day HTTP-only refresh tokens
- All financial amounts stored as `DECIMAL(20,8)` in PostgreSQL
- Idempotency keys prevent duplicate payment processing
- Workspace-scoped middleware on all resource endpoints
