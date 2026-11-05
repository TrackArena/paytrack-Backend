import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireWorkspace, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../lib/response';
import Decimal from 'decimal.js';

const router = Router();

router.use(authenticate);
router.use('/:workspaceId', requireWorkspace);

const dateRangeSchema = z.object({
  period: z.enum(['today', '7d', '30d', '90d', 'all']).default('30d'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function getDateRange(period: string, from?: string, to?: string) {
  const now = new Date();
  const toDate = to ? new Date(to) : now;
  let fromDate: Date;

  switch (period) {
    case 'today':
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case '7d':
      fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      fromDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
      fromDate = new Date('2020-01-01');
      break;
    default:
      fromDate = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  return { fromDate, toDate };
}

/**
 * GET /api/v1/dashboard/:workspaceId/overview
 * Returns KPI metrics for the dashboard header cards
 */
router.get(
  '/:workspaceId/overview',
  validate(dateRangeSchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const { period, from, to } = req.query as { period: string; from?: string; to?: string };
      const { fromDate, toDate } = getDateRange(period, from, to);

      const [
        totalRevenue,
        paymentsInPeriod,
        invoiceSummary,
        recentTransactions,
      ] = await Promise.all([
        // Total revenue (all completed payments)
        prisma.payment.aggregate({
          where: { workspaceId, status: 'COMPLETED' },
          _sum: { amount: true },
        }),

        // Payments in selected period
        prisma.payment.groupBy({
          by: ['status'],
          where: {
            workspaceId,
            createdAt: { gte: fromDate, lte: toDate },
          },
          _sum: { amount: true },
          _count: { id: true },
        }),

        // Invoice counts by status
        prisma.invoice.groupBy({
          by: ['status'],
          where: { workspaceId, deletedAt: null },
          _sum: { totalAmount: true },
          _count: { id: true },
        }),

        // Recent 5 transactions
        prisma.payment.findMany({
          where: { workspaceId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            invoice: { select: { invoiceNumber: true } },
            customer: { select: { name: true } },
            blockchainTransaction: {
              select: { transactionHash: true, assetCode: true },
            },
          },
        }),
      ]);

      // Aggregate payment stats
      const paymentStats = {
        total: 0,
        totalAmount: new Decimal(0),
        completed: 0,
        completedAmount: new Decimal(0),
        pending: 0,
        pendingAmount: new Decimal(0),
        failed: 0,
      };

      for (const group of paymentsInPeriod) {
        const count = group._count.id;
        const amount = new Decimal(group._sum.amount?.toString() || '0');
        paymentStats.total += count;
        paymentStats.totalAmount = paymentStats.totalAmount.plus(amount);

        if (group.status === 'COMPLETED') {
          paymentStats.completed = count;
          paymentStats.completedAmount = amount;
        } else if (group.status === 'PENDING') {
          paymentStats.pending = count;
          paymentStats.pendingAmount = amount;
        } else if (group.status === 'FAILED') {
          paymentStats.failed = count;
        }
      }

      // Invoice aggregates
      const invoiceStats = {
        total: 0,
        draft: 0,
        pending: 0,
        pendingAmount: new Decimal(0),
        paid: 0,
        paidAmount: new Decimal(0),
        overdue: 0,
        overdueAmount: new Decimal(0),
        outstanding: new Decimal(0),
      };

      for (const group of invoiceSummary) {
        const count = group._count.id;
        const amount = new Decimal(group._sum.totalAmount?.toString() || '0');
        invoiceStats.total += count;

        switch (group.status) {
          case 'DRAFT':
            invoiceStats.draft = count;
            break;
          case 'PENDING':
            invoiceStats.pending += count;
            invoiceStats.pendingAmount = invoiceStats.pendingAmount.plus(amount);
            invoiceStats.outstanding = invoiceStats.outstanding.plus(amount);
            break;
          case 'PARTIALLY_PAID':
            invoiceStats.pending += count;
            invoiceStats.outstanding = invoiceStats.outstanding.plus(amount);
            break;
          case 'PAID':
            invoiceStats.paid = count;
            invoiceStats.paidAmount = invoiceStats.paidAmount.plus(amount);
            break;
          case 'OVERDUE':
            invoiceStats.overdue = count;
            invoiceStats.overdueAmount = invoiceStats.overdueAmount.plus(amount);
            invoiceStats.outstanding = invoiceStats.outstanding.plus(amount);
            break;
        }
      }

      sendSuccess(res, {
        period,
        dateRange: { from: fromDate, to: toDate },
        revenue: {
          total: totalRevenue._sum.amount?.toString() || '0',
          inPeriod: paymentStats.completedAmount.toString(),
        },
        payments: {
          total: paymentStats.total,
          completed: paymentStats.completed,
          pending: paymentStats.pending,
          failed: paymentStats.failed,
          totalAmount: paymentStats.totalAmount.toString(),
        },
        invoices: {
          total: invoiceStats.total,
          draft: invoiceStats.draft,
          pending: invoiceStats.pending,
          paid: invoiceStats.paid,
          overdue: invoiceStats.overdue,
          outstanding: invoiceStats.outstanding.toString(),
        },
        recentTransactions: recentTransactions.map((p: {
          id: string; amount: { toString(): string }; currency: string; status: string; createdAt: Date;
          invoice?: { invoiceNumber: string } | null;
          customer?: { name: string } | null;
          blockchainTransaction?: { transactionHash: string } | null;
        }) => ({
          id: p.id,
          amount: p.amount.toString(),
          currency: p.currency,
          status: p.status,
          invoiceNumber: p.invoice?.invoiceNumber,
          customerName: p.customer?.name,
          transactionHash: p.blockchainTransaction?.transactionHash,
          createdAt: p.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/dashboard/:workspaceId/revenue
 * Returns daily revenue data for chart
 */
router.get(
  '/:workspaceId/revenue',
  validate(dateRangeSchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const { period, from, to } = req.query as { period: string; from?: string; to?: string };
      const { fromDate, toDate } = getDateRange(period, from, to);

      // Raw SQL for daily aggregation
      const dailyRevenue = await prisma.$queryRaw<
        Array<{ date: Date; total: string; count: bigint }>
      >`
        SELECT
          DATE_TRUNC('day', created_at) as date,
          SUM(amount)::text as total,
          COUNT(*)::bigint as count
        FROM payments
        WHERE workspace_id = ${workspaceId}
          AND status = 'COMPLETED'
          AND created_at >= ${fromDate}
          AND created_at <= ${toDate}
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY date ASC
      `;

      sendSuccess(res, {
        period,
        dateRange: { from: fromDate, to: toDate },
        data: dailyRevenue.map((row: { date: Date; total: string; count: bigint }) => ({
          date: row.date,
          total: row.total || '0',
          count: Number(row.count),
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/dashboard/:workspaceId/activity
 * Returns recent activity feed
 */
router.get(
  '/:workspaceId/activity',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.workspaceId!;
      const limit = parseInt(req.query.limit as string || '20', 10);

      const logs = await prisma.auditLog.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 50),
        include: {
          user: { select: { firstName: true, lastName: true } },
        },
      });

      sendSuccess(res, logs);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
