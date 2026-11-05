import Decimal from 'decimal.js';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { PaymentError } from '../../lib/errors';
import type { VerifiedTransaction } from '../stellar/stellar.service';

// Configure Decimal.js for financial operations
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

// Prisma interactive transaction client type
type PrismaTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export interface ReconcileInput {
  transactionHash: string;
  workspaceId: string;
  invoiceId?: string;
  txDetails: VerifiedTransaction;
  submittedByUserId: string | null;
}

export interface ReconcileResult {
  payment: {
    id: string;
    amount: string;
    status: string;
    stellarTransactionHash: string | null;
  };
  reconciliation: {
    status: string;
    matchConfidence: string | null;
    difference: string | null;
    invoiceId: string | null;
  };
  invoice: {
    id: string;
    invoiceNumber: string;
    status: string;
    paidAmount: string;
    totalAmount: string;
  } | null;
}

export class ReconciliationEngine {

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    const { transactionHash, workspaceId, invoiceId, txDetails, submittedByUserId } = input;

    logger.info('Starting reconciliation', {
      transactionHash,
      workspaceId,
      amount: txDetails.amount,
    });

    return await prisma.$transaction(async (tx: PrismaTx) => {

      // 1. Idempotency guard — atomic inside transaction
      const existing = await tx.payment.findUnique({
        where: { stellarTransactionHash: transactionHash },
        include: { reconciliation: true, invoice: true },
      });

      if (existing) {
        logger.info('Duplicate transaction detected', { transactionHash });
        return this.formatResult(existing, existing.reconciliation, existing.invoice);
      }

      // 2. Build payment amount
      const paymentAmount = new Decimal(txDetails.amount);
      const idempotencyKey = `stellar:${transactionHash}`;

      // 3. Create Payment + BlockchainTransaction records
      const payment = await tx.payment.create({
        data: {
          workspaceId,
          invoiceId: invoiceId || null,
          status: 'PENDING',
          amount: paymentAmount,
          currency: txDetails.assetCode,
          stellarTransactionHash: transactionHash,
          idempotencyKey,
          receivedAt: new Date(txDetails.createdAt),
          blockchainTransaction: {
            create: {
              transactionHash,
              network: txDetails.network,
              ledger: txDetails.ledger ? BigInt(txDetails.ledger) : null,
              sourceAccount: txDetails.sourceAccount,
              destinationAccount: txDetails.destinationAccount,
              assetCode: txDetails.assetCode,
              assetIssuer: txDetails.assetIssuer,
              amount: paymentAmount,
              memo: txDetails.memo,
              status: 'VERIFIED',
              verifiedAt: new Date(),
              stellarCreatedAt: new Date(txDetails.createdAt),
              rawData: txDetails as unknown as import('@prisma/client').Prisma.InputJsonObject,
            },
          },
        },
        include: { blockchainTransaction: true },
      });

      // 4. Find matching invoice
      const matchedInvoice = invoiceId
        ? await tx.invoice.findFirst({
            where: { id: invoiceId, workspaceId, deletedAt: null },
          })
        : await this.findMatchingInvoice(tx, workspaceId, txDetails, paymentAmount);

      // 5. Run reconciliation
      const reconcileResult = await this.performReconciliation(
        tx,
        payment.id,
        matchedInvoice,
        paymentAmount
      );

      // 6. Mark payment completed
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'COMPLETED',
          invoiceId: matchedInvoice?.id || null,
          verifiedAt: new Date(),
        },
      });

      // 7. Audit log
      await tx.auditLog.create({
        data: {
          workspaceId,
          userId: submittedByUserId,
          action: 'payment.reconciled',
          entityType: 'Payment',
          entityId: payment.id,
          newData: {
            transactionHash,
            amount: paymentAmount.toString(),
            invoiceId: matchedInvoice?.id,
            reconciliationStatus: reconcileResult.status,
          },
        },
      });

      // 8. Notification
      await tx.notification.create({
        data: {
          workspaceId,
          type: 'PAYMENT_RECEIVED',
          title: 'Payment Received',
          message: `Payment of ${paymentAmount.toString()} ${txDetails.assetCode} received${
            matchedInvoice ? ` for invoice ${matchedInvoice.invoiceNumber}` : ''
          }`,
          data: {
            paymentId: payment.id,
            transactionHash,
            amount: paymentAmount.toString(),
            invoiceId: matchedInvoice?.id,
          },
        },
      });

      const updatedInvoice = matchedInvoice
        ? await tx.invoice.findUnique({ where: { id: matchedInvoice.id } })
        : null;

      return this.formatResult(
        { ...payment, status: 'COMPLETED', invoiceId: matchedInvoice?.id || null },
        reconcileResult,
        updatedInvoice
      );
    });
  }

  private async findMatchingInvoice(
    tx: PrismaTx,
    workspaceId: string,
    txDetails: VerifiedTransaction,
    amount: Decimal
  ) {
    // Priority 1: memo match
    if (txDetails.memo) {
      const memoMatch = await tx.invoice.findFirst({
        where: {
          workspaceId,
          deletedAt: null,
          status: { in: ['PENDING', 'PARTIALLY_PAID', 'OVERDUE'] },
          OR: [
            { memo: { equals: txDetails.memo, mode: 'insensitive' } },
            { invoiceNumber: { contains: txDetails.memo, mode: 'insensitive' } },
          ],
        },
      });
      if (memoMatch) {
        logger.info('Matched invoice by memo', { invoiceId: memoMatch.id, memo: txDetails.memo });
        return memoMatch;
      }
    }

    // Priority 2: exact amount match (only if unique)
    const amountMatches = await tx.invoice.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        status: { in: ['PENDING', 'OVERDUE'] },
        totalAmount: amount,
      },
    });

    if (amountMatches.length === 1) {
      logger.info('Matched invoice by exact amount', {
        invoiceId: amountMatches[0].id,
        amount: amount.toString(),
      });
      return amountMatches[0];
    }

    logger.info('No invoice match found', { amount: amount.toString(), memo: txDetails.memo });
    return null;
  }

  private async performReconciliation(
    tx: PrismaTx,
    paymentId: string,
    invoice: { id: string; totalAmount: { toString(): string } | string; paidAmount: { toString(): string } | string; invoiceNumber: string } | null,
    paymentAmount: Decimal
  ) {
    if (!invoice) {
      return tx.paymentReconciliation.create({
        data: {
          paymentId,
          invoiceId: null,
          status: 'UNMATCHED',
          paymentAmount,
          matchConfidence: new Decimal(0),
          notes: 'No matching invoice found',
        },
      });
    }

    const invoiceTotal = new Decimal(invoice.totalAmount.toString());
    const alreadyPaid = new Decimal(invoice.paidAmount.toString());
    const remaining = invoiceTotal.minus(alreadyPaid);
    const newPaidTotal = alreadyPaid.plus(paymentAmount);
    const difference = paymentAmount.minus(remaining);

    let reconciliationStatus: 'MATCHED' | 'PARTIAL_MATCH' | 'OVERPAYMENT';
    let invoiceStatus: 'PAID' | 'PARTIALLY_PAID';
    let matchConfidence: Decimal;

    if (difference.isZero()) {
      reconciliationStatus = 'MATCHED';
      invoiceStatus = 'PAID';
      matchConfidence = new Decimal(100);
    } else if (difference.isPositive()) {
      reconciliationStatus = 'OVERPAYMENT';
      invoiceStatus = 'PAID';
      matchConfidence = new Decimal(95);
    } else {
      reconciliationStatus = 'PARTIAL_MATCH';
      invoiceStatus = 'PARTIALLY_PAID';
      matchConfidence = paymentAmount
        .dividedBy(invoiceTotal)
        .times(100)
        .toDecimalPlaces(2);
    }

    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        paidAmount: newPaidTotal,
        status: invoiceStatus,
        ...(invoiceStatus === 'PAID' && { paidAt: new Date() }),
      },
    });

    const rec = await tx.paymentReconciliation.create({
      data: {
        paymentId,
        invoiceId: invoice.id,
        status: reconciliationStatus,
        paymentAmount,
        invoiceAmount: invoiceTotal,
        difference,
        matchConfidence,
        notes: this.buildNote(reconciliationStatus, difference),
      },
    });

    logger.info('Reconciliation complete', {
      paymentId,
      invoiceId: invoice.id,
      status: reconciliationStatus,
    });

    return rec;
  }

  async matchPaymentToInvoice(paymentId: string, invoiceId: string): Promise<ReconcileResult> {
    return await prisma.$transaction(async (tx: PrismaTx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { invoice: true, reconciliation: true },
      });
      if (!payment) throw new PaymentError('Payment not found');

      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new PaymentError('Invoice not found');

      if (payment.reconciliation?.status === 'UNMATCHED') {
        await tx.paymentReconciliation.delete({ where: { paymentId } });
      }

      const newRec = await this.performReconciliation(
        tx,
        paymentId,
        invoice,
        new Decimal(payment.amount.toString())
      );

      await tx.payment.update({ where: { id: paymentId }, data: { invoiceId } });

      const updatedInvoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      return this.formatResult(payment, newRec, updatedInvoice);
    });
  }

  private buildNote(status: string, difference: Decimal): string {
    switch (status) {
      case 'MATCHED':      return 'Payment exactly matches invoice amount';
      case 'OVERPAYMENT':  return `Overpayment of ${difference.abs().toFixed(7)}`;
      case 'PARTIAL_MATCH':return `Underpayment of ${difference.abs().toFixed(7)}`;
      default:             return '';
    }
  }

  private formatResult(
    payment: { id: string; amount: { toString(): string } | string | number; status: string; stellarTransactionHash?: string | null; invoiceId?: string | null },
    reconciliation: { status: string; matchConfidence?: { toString(): string } | null; difference?: { toString(): string } | null; invoiceId?: string | null } | null,
    invoice: { id: string; invoiceNumber: string; status: string; paidAmount: { toString(): string } | string | number; totalAmount: { toString(): string } | string | number } | null
  ): ReconcileResult {
    return {
      payment: {
        id: payment.id,
        amount: payment.amount.toString(),
        status: payment.status,
        stellarTransactionHash: payment.stellarTransactionHash ?? null,
      },
      reconciliation: {
        status: reconciliation?.status || 'UNMATCHED',
        matchConfidence: reconciliation?.matchConfidence?.toString() ?? null,
        difference: reconciliation?.difference?.toString() ?? null,
        invoiceId: reconciliation?.invoiceId ?? null,
      },
      invoice: invoice
        ? {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            status: invoice.status,
            paidAmount: invoice.paidAmount.toString(),
            totalAmount: invoice.totalAmount.toString(),
          }
        : null,
    };
  }
}
