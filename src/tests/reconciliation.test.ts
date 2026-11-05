import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';

// Mock Prisma to avoid database dependency in unit tests
vi.mock('../lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
    payment: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    invoice: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    paymentReconciliation: { create: vi.fn(), delete: vi.fn() },
    blockchainTransaction: { create: vi.fn() },
    notification: { create: vi.fn() },
    auditLog: { create: vi.fn() },
  },
}));

const mockTx = {
  payment: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  invoice: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  paymentReconciliation: { create: vi.fn(), delete: vi.fn() },
  notification: { create: vi.fn() },
  auditLog: { create: vi.fn() },
};

import { ReconciliationEngine } from '../services/payment/reconciliation.engine';
import type { VerifiedTransaction } from '../services/stellar/stellar.service';

const engine = new ReconciliationEngine();

const baseTx: VerifiedTransaction = {
  hash: 'abc123hash',
  network: 'testnet',
  ledger: 12345,
  sourceAccount: 'GCUSTOMER0000000000000000000000000000000000000000000000001',
  destinationAccount: 'GBUSINESS0000000000000000000000000000000000000000000000001',
  assetCode: 'USDC',
  assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  amount: '150.0000000',
  memo: 'INV20240001',
  createdAt: new Date().toISOString(),
  successful: true,
  isUSDC: true,
  explorerUrl: 'https://stellar.expert/explorer/testnet/tx/abc123hash',
};

const baseInvoice = {
  id: 'invoice-uuid-1',
  invoiceNumber: 'INV-2024-0001',
  totalAmount: new Decimal('150.0000000'),
  paidAmount: new Decimal('0'),
  status: 'PENDING',
  workspaceId: 'workspace-uuid-1',
  memo: 'INV20240001',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.payment.findUnique.mockResolvedValue(null); // no duplicate
  mockTx.payment.create.mockResolvedValue({
    id: 'payment-uuid-1',
    amount: new Decimal('150.0000000'),
    status: 'PENDING',
    stellarTransactionHash: baseTx.hash,
    workspaceId: 'workspace-uuid-1',
    invoiceId: null,
  });
  mockTx.payment.update.mockResolvedValue({});
  mockTx.invoice.findFirst.mockResolvedValue(baseInvoice);
  mockTx.invoice.findMany.mockResolvedValue([baseInvoice]);
  mockTx.invoice.findUnique.mockResolvedValue({ ...baseInvoice, status: 'PAID', paidAmount: new Decimal('150') });
  mockTx.invoice.update.mockResolvedValue({});
  mockTx.paymentReconciliation.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...data, id: 'recon-uuid-1' })
  );
  mockTx.notification.create.mockResolvedValue({});
  mockTx.auditLog.create.mockResolvedValue({});
});

describe('ReconciliationEngine — exact payment', () => {
  it('creates MATCHED reconciliation for exact payment', async () => {
    const { prisma } = await import('../lib/prisma');
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    const result = await engine.reconcile({
      transactionHash: baseTx.hash,
      workspaceId: 'workspace-uuid-1',
      txDetails: baseTx,
      submittedByUserId: 'user-uuid-1',
    });

    expect(mockTx.paymentReconciliation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'MATCHED' }),
      })
    );
    expect(mockTx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PAID' }),
      })
    );
  });
});

describe('ReconciliationEngine — overpayment', () => {
  it('creates OVERPAYMENT reconciliation when payment exceeds invoice', async () => {
    const overpayTx = { ...baseTx, amount: '200.0000000' };
    const { prisma } = await import('../lib/prisma');
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    await engine.reconcile({
      transactionHash: overpayTx.hash,
      workspaceId: 'workspace-uuid-1',
      txDetails: overpayTx,
      submittedByUserId: 'user-uuid-1',
    });

    expect(mockTx.paymentReconciliation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'OVERPAYMENT' }),
      })
    );
    expect(mockTx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PAID' }),
      })
    );
  });
});

describe('ReconciliationEngine — underpayment', () => {
  it('creates PARTIAL_MATCH reconciliation when payment is less than invoice', async () => {
    const underpayTx = { ...baseTx, amount: '75.0000000', hash: 'underpay_hash' };
    const { prisma } = await import('../lib/prisma');
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    await engine.reconcile({
      transactionHash: underpayTx.hash,
      workspaceId: 'workspace-uuid-1',
      txDetails: underpayTx,
      submittedByUserId: 'user-uuid-1',
    });

    expect(mockTx.paymentReconciliation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PARTIAL_MATCH' }),
      })
    );
    expect(mockTx.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PARTIALLY_PAID' }),
      })
    );
  });
});

describe('ReconciliationEngine — unmatched', () => {
  it('creates UNMATCHED reconciliation when no invoice found', async () => {
    mockTx.invoice.findFirst.mockResolvedValue(null);
    mockTx.invoice.findMany.mockResolvedValue([]);

    const { prisma } = await import('../lib/prisma');
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    await engine.reconcile({
      transactionHash: 'unmatched_hash',
      workspaceId: 'workspace-uuid-1',
      txDetails: { ...baseTx, hash: 'unmatched_hash', memo: null },
      submittedByUserId: null,
    });

    expect(mockTx.paymentReconciliation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'UNMATCHED' }),
      })
    );
  });
});

describe('ReconciliationEngine — duplicate prevention', () => {
  it('returns existing payment without creating a new one for duplicate hash', async () => {
    const existingPayment = {
      id: 'existing-payment-id',
      amount: new Decimal('150'),
      status: 'COMPLETED',
      stellarTransactionHash: baseTx.hash,
      invoiceId: baseInvoice.id,
      reconciliation: { status: 'MATCHED', matchConfidence: new Decimal(100), difference: new Decimal(0), invoiceId: baseInvoice.id },
      invoice: { ...baseInvoice, status: 'PAID' },
    };
    mockTx.payment.findUnique.mockResolvedValue(existingPayment);

    const { prisma } = await import('../lib/prisma');
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)
    );

    await engine.reconcile({
      transactionHash: baseTx.hash,
      workspaceId: 'workspace-uuid-1',
      txDetails: baseTx,
      submittedByUserId: null,
    });

    // Should NOT create a new payment
    expect(mockTx.payment.create).not.toHaveBeenCalled();
    expect(mockTx.paymentReconciliation.create).not.toHaveBeenCalled();
  });
});
