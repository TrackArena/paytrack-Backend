import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { sendSuccess } from '../lib/response';
import Decimal from 'decimal.js';

const router = Router();
router.use(authenticate);

const reportQuerySchema = z.object({
  workspaceId: z.string().uuid(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/**
 * GET /api/v1/reports/revenue
 */
router.get(
  '/revenue',
  validate(reportQuerySchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, from, to } = req.query as {
        workspaceId: string; from?: string; to?: string;
      };

      const dateFilter = {
        ...(from && { gte: new Date(from) }),
        ...(to && { lte: new Date(to) }),
      };

      const [payments, byMonth] = await Promise.all([
        prisma.payment.aggregate({
          where: {
            workspaceId,
            status: 'COMPLETED',
            ...(Object.keys(dateFilter).length && { createdAt: dateFilter }),
          },
          _sum: { amount: true },
          _count: { id: true },
          _avg: { amount: true },
        }),
        prisma.$queryRaw<Array<{ month: string; total: string; count: bigint }>>`
          SELECT
            TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month,
            SUM(amount)::text as total,
            COUNT(*)::bigint as count
          FROM payments
          WHERE workspace_id = ${workspaceId}
            AND status = 'COMPLETED'
            ${from ? prisma.$queryRaw`AND created_at >= ${new Date(from)}` : prisma.$queryRaw``}
            ${to ? prisma.$queryRaw`AND created_at <= ${new Date(to)}` : prisma.$queryRaw``}
          GROUP BY DATE_TRUNC('month', created_at)
          ORDER BY month ASC
        `,
      ]);

      sendSuccess(res, {
        summary: {
          total: payments._sum.amount?.toString() || '0',
          count: payments._count.id,
          average: payments._avg.amount?.toString() || '0',
        },
        byMonth: byMonth.map((r: { month: string; total: string; count: bigint }) => ({
          month: r.month,
          total: r.total || '0',
          count: Number(r.count),
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/reports/invoices
 */
router.get(
  '/invoices',
  validate(reportQuerySchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, from, to } = req.query as {
        workspaceId: string; from?: string; to?: string;
      };

      const dateFilter = {
        ...(from && { gte: new Date(from) }),
        ...(to && { lte: new Date(to) }),
      };

      const byStatus = await prisma.invoice.groupBy({
        by: ['status'],
        where: {
          workspaceId,
          deletedAt: null,
          ...(Object.keys(dateFilter).length && { createdAt: dateFilter }),
        },
        _sum: { totalAmount: true, paidAmount: true },
        _count: { id: true },
      });

      const totals = byStatus.reduce(
        (acc: { totalInvoiced: Decimal; totalPaid: Decimal; count: number }, group: { _sum: { totalAmount: unknown; paidAmount: unknown }; _count: { id: number } }) => {
          acc.totalInvoiced = acc.totalInvoiced.plus(
            new Decimal(group._sum.totalAmount?.toString() || '0')
          );
          acc.totalPaid = acc.totalPaid.plus(
            new Decimal(group._sum.paidAmount?.toString() || '0')
          );
          acc.count += group._count.id;
          return acc;
        },
        { totalInvoiced: new Decimal(0), totalPaid: new Decimal(0), count: 0 }
      );

      sendSuccess(res, {
        summary: {
          totalInvoiced: totals.totalInvoiced.toString(),
          totalPaid: totals.totalPaid.toString(),
          outstanding: totals.totalInvoiced.minus(totals.totalPaid).toString(),
          count: totals.count,
        },
        byStatus: byStatus.map((g: { status: string; _count: { id: number }; _sum: { totalAmount: unknown; paidAmount: unknown } }) => ({
          status: g.status,
          count: g._count.id,
          totalAmount: g._sum.totalAmount?.toString() || '0',
          paidAmount: g._sum.paidAmount?.toString() || '0',
        })),
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/reports/transactions
 */
router.get(
  '/transactions',
  validate(reportQuerySchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, from, to } = req.query as {
        workspaceId: string; from?: string; to?: string;
      };

      const dateFilter = {
        ...(from && { gte: new Date(from) }),
        ...(to && { lte: new Date(to) }),
      };

      const transactions = await prisma.blockchainTransaction.findMany({
        where: {
          payment: {
            workspaceId,
            ...(Object.keys(dateFilter).length && { createdAt: dateFilter }),
          },
        },
        include: {
          payment: {
            include: {
              invoice: { select: { invoiceNumber: true } },
              customer: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      sendSuccess(res, transactions);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
