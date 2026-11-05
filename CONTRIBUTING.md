# Contributing to paytrack-backend

The backend is the core of PayTrack — it owns the database, the payment reconciliation engine, the Stellar SDK integration, and all authoritative business logic. Contributions here have the highest impact.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- npm 9+

### Setup

```bash
# 1. Fork and clone
git clone https://github.com/YOUR_USERNAME/paytrack-backend
cd paytrack-backend

# 2. Install dependencies
npm install

# 3. Generate Prisma client
node node_modules/prisma/build/index.js generate

# 4. Set up environment
cp .env.example .env
# Edit .env — minimum required: DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET

# 5. Set up database
# Create the database first: createdb paytrack_dev
node node_modules/prisma/build/index.js migrate dev

# 6. Seed development data
npm run db:seed

# 7. Start dev server
npm run dev
```

The API runs on `http://localhost:3001`.

## Project Structure

```
src/
├── app.ts                  Express app setup
├── index.ts                Entry point + transaction monitor startup
├── lib/                    Shared utilities (prisma, logger, errors, response)
├── middleware/             Auth, validation, error handling
├── routes/                 One file per resource group
└── services/
    ├── auth.service.ts     Password hashing, JWT, session management
    ├── payment/            Reconciliation engine
    └── stellar/            Stellar SDK client + transaction monitor
```

## Branching

- `main` — stable releases
- `feat/feature-name` — new features
- `fix/issue-description` — bug fixes

## Code Standards

- **Zero TypeScript errors**: `npm run typecheck` must pass
- **Tests required**: new business logic needs unit or integration tests
- **No hardcoded amounts**: all financial values use `Decimal.js`
- **Idempotency**: payment-related mutations must be idempotent
- **Audit logging**: financial operations must write to `AuditLog`
- **Error handling**: use typed errors from `src/lib/errors.ts`; never swallow errors silently

## Running Tests

```bash
npm test                    # All tests (unit tests pass without DB)
npm run test:watch          # Watch mode
```

Integration tests (auth routes) require a running PostgreSQL database. Unit tests (Stellar, reconciliation) mock all external dependencies and run without any infrastructure.

## Database Changes

1. Edit `prisma/schema.prisma`
2. Run `node node_modules/prisma/build/index.js migrate dev --name describe-your-change`
3. Update seed data if needed
4. Document the migration rationale in the PR

Never modify existing migrations. Always create a new one.

## Adding an API Endpoint

1. Add the route handler in the appropriate `src/routes/*.routes.ts` file
2. Add Zod validation with `validate()` middleware
3. Apply `authenticate` and workspace access checks
4. Write at least one test
5. Document the endpoint in `README.md`

## Pull Requests

- One feature or fix per PR
- Pass `typecheck`, `lint`, and `test`
- Describe what changed and why
- Reference any related issues

## Financial Logic Rules

These are non-negotiable for any PR touching payments or invoices:

- Use `Decimal.js` for all arithmetic — never native JS floats
- Amounts stored as `DECIMAL(20,8)` in PostgreSQL
- Payment processing must be wrapped in `prisma.$transaction`
- Duplicate detection via idempotency key must be checked before processing
- Stellar transaction details must be fetched from Horizon, never trusted from client input
