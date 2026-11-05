import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { param } from '../lib/params';
import { sendSuccess } from '../lib/response';
import { NotFoundError } from '../lib/errors';
import { ReconciliationEngine } from '../services/payment/reconciliation.engine';
import { StellarService } from '../services/stellar/stellar.service';

const router = Router();
router.use(authenticate);

const reconciliation = new ReconciliationEngine();
const stellar = new StellarService();

const verifySchema = z.object({
  transactionHash: z.string().min(1).max(100),
  workspaceId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
});

/**
 * GET /api/v1/payments?workspaceId=...
 */
router.get(
  '/',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.query.workspaceId as string || req.headers['x-workspace-id'] as string;
      if (!workspaceId) {
        res.status(400).json({ success: false, message: 'workspaceId required' });
        return;
      }

      const page = parseInt(req.query.page as string || '1', 10);
      const limit = parseInt(req.query.limit as string || '20', 10);
      const status = req.query.status as string | undefined;

      const where = {
        workspaceId,
        ...(status && { status: status as never }),
      };

      const [payments, total] = await Promise.all([
        prisma.payment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            invoice: { select: { invoiceNumber: true, totalAmount: true } },
            customer: { select: { name: true } },
            blockchainTransaction: {
              select: {
                transactionHash: true,
                assetCode: true,
                network: true,
                status: true,
                stellarCreatedAt: true,
              },
            },
            reconciliation: {
              select: { status: true, matchConfidence: true, difference: true },
            },
          },
        }),
        prisma.payment.count({ where }),
      ]);

      sendSuccess(res, payments, undefined, 200, {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/payments/:id
 */
router.get(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const payment = await prisma.payment.findFirst({
        where: { id: param(req, "id"), workspaceId },
        include: {
          invoice: { include: { items: true } },
          customer: true,
          blockchainTransaction: true,
          reconciliation: true,
        },
      });

      if (!payment) throw new NotFoundError('Payment');
      sendSuccess(res, payment);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/payments/verify
 * Manually verify a Stellar transaction and attempt reconciliation.
 * The backend independently fetches and verifies the transaction — never trusts
 * client-supplied payment details.
 */
router.post(
  '/verify',
  validate(verifySchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { transactionHash, workspaceId, invoiceId } = req.body;

      // Check idempotency — has this transaction already been processed?
      const existing = await prisma.payment.findUnique({
        where: { stellarTransactionHash: transactionHash },
        include: { reconciliation: true },
      });

      if (existing) {
        sendSuccess(res, {
          payment: existing,
          message: 'Transaction already processed',
          idempotent: true,
        });
        return;
      }

      // Verify with Stellar network
      const network = process.env.STELLAR_NETWORK as 'testnet' | 'mainnet' || 'testnet';
      const txDetails = await stellar.verifyTransaction(transactionHash, network);

      if (!txDetails) {
        res.status(422).json({
          success: false,
          message: 'Transaction not found on the Stellar network',
          code: 'TRANSACTION_NOT_FOUND',
        });
        return;
      }

      // Run reconciliation engine
      const result = await reconciliation.reconcile({
        transactionHash,
        workspaceId,
        invoiceId,
        txDetails,
        submittedByUserId: req.user!.id,
      });

      sendSuccess(res, result, 'Transaction verified and reconciled');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/payments/reconcile
 * Manually trigger reconciliation for an existing payment
 */
router.post(
  '/reconcile',
  validate(z.object({ paymentId: z.string().uuid(), invoiceId: z.string().uuid() })),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { paymentId, invoiceId } = req.body;
      const workspaceId = req.headers['x-workspace-id'] as string;

      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, workspaceId },
        include: { blockchainTransaction: true },
      });
      if (!payment) throw new NotFoundError('Payment');

      const result = await reconciliation.matchPaymentToInvoice(payment.id, invoiceId);
      sendSuccess(res, result, 'Reconciliation complete');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
