import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { param } from '../lib/params';
import { sendSuccess, sendCreated } from '../lib/response';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();
router.use(authenticate);

// ============================================================
// Validation Schemas
// ============================================================

const invoiceItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.coerce.number().positive().max(999999),
  unitPrice: z.coerce.number().min(0).max(999999999),
});

const createInvoiceSchema = z.object({
  workspaceId: z.string().uuid(),
  customerId: z.string().uuid().optional().nullable(),
  currency: z.string().length(3).default('USDC'),
  dueDate: z.string().datetime().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  items: z.array(invoiceItemSchema).min(1, 'At least one line item is required'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  discountAmount: z.coerce.number().min(0).default(0),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['DRAFT', 'PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().optional(),
});

// ============================================================
// Helpers
// ============================================================

async function generateInvoiceNumber(workspaceId: string): Promise<string> {
  const count = await prisma.invoice.count({ where: { workspaceId } });
  const year = new Date().getFullYear();
  const seq = String(count + 1).padStart(4, '0');
  return `INV-${year}-${seq}`;
}

function calculateInvoiceTotals(
  items: Array<{ quantity: number; unitPrice: number }>,
  taxRate: number,
  discountAmount: number
) {
  const subtotal = items.reduce((sum, item) => {
    return sum.plus(new Decimal(item.quantity).times(new Decimal(item.unitPrice)));
  }, new Decimal(0));

  const taxAmount = subtotal.times(new Decimal(taxRate).dividedBy(100)).toDecimalPlaces(8);
  const discount = new Decimal(discountAmount).toDecimalPlaces(8);
  const total = subtotal.plus(taxAmount).minus(discount);

  if (total.isNegative()) {
    throw new ValidationError('Invoice total cannot be negative');
  }

  return { subtotal, taxAmount, discount, total };
}

// ============================================================
// Routes
// ============================================================

/**
 * GET /api/v1/invoices
 */
router.get(
  '/',
  validate(listSchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      if (!workspaceId) {
        res.status(400).json({ success: false, message: 'workspaceId header required' });
        return;
      }

      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const status = req.query.status as string | undefined;
      const customerId = req.query.customerId as string | undefined;
      const search = req.query.search as string | undefined;

      const where = {
        workspaceId,
        deletedAt: null,
        ...(status && { status: status as never }),
        ...(customerId && { customerId }),
        ...(search && {
          OR: [
            { invoiceNumber: { contains: search, mode: 'insensitive' as const } },
            { customer: { name: { contains: search, mode: 'insensitive' as const } } },
            { notes: { contains: search, mode: 'insensitive' as const } },
          ],
        }),
      };

      const [invoices, total] = await Promise.all([
        prisma.invoice.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            customer: { select: { id: true, name: true, email: true } },
            items: true,
            _count: { select: { payments: true } },
          },
        }),
        prisma.invoice.count({ where }),
      ]);

      sendSuccess(res, invoices, undefined, 200, {
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
 * POST /api/v1/invoices
 */
router.post(
  '/',
  validate(createInvoiceSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, customerId, currency, dueDate, notes, items, taxRate, discountAmount } =
        req.body;

      const { subtotal, taxAmount, discount, total } = calculateInvoiceTotals(
        items,
        taxRate,
        discountAmount
      );

      const invoiceNumber = await generateInvoiceNumber(workspaceId);
      // Memo for Stellar payment matching — first 28 chars of invoice number
      const memo = invoiceNumber.replace(/[^A-Z0-9-]/gi, '').substring(0, 28);

      const invoice = await prisma.$transaction(async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
        const inv = await tx.invoice.create({
          data: {
            workspaceId,
            customerId: customerId || null,
            invoiceNumber,
            currency,
            subtotal,
            taxAmount,
            discountAmount: discount,
            totalAmount: total,
            dueDate: dueDate ? new Date(dueDate) : null,
            notes,
            memo,
            status: 'DRAFT',
            publicToken: uuidv4(),
            items: {
              create: items.map((item: { description: string; quantity: number; unitPrice: number }) => ({
                description: item.description,
                quantity: new Decimal(item.quantity),
                unitPrice: new Decimal(item.unitPrice),
                amount: new Decimal(item.quantity).times(new Decimal(item.unitPrice)),
              })),
            },
          },
          include: { items: true, customer: true },
        });

        await tx.auditLog.create({
          data: {
            workspaceId,
            userId: req.user!.id,
            action: 'invoice.created',
            entityType: 'Invoice',
            entityId: inv.id,
            newData: { invoiceNumber, totalAmount: total.toString() },
          },
        });

        return inv;
      });

      sendCreated(res, invoice, 'Invoice created');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/invoices/:id
 */
router.get(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const invoice = await prisma.invoice.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
        include: {
          customer: true,
          items: true,
          payments: {
            include: {
              blockchainTransaction: true,
              reconciliation: true,
            },
            orderBy: { createdAt: 'desc' },
          },
          paymentLinks: { where: { isActive: true } },
        },
      });

      if (!invoice) throw new NotFoundError('Invoice');
      sendSuccess(res, invoice);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/invoices/public/:token
 * Public endpoint — no auth required — for customer-facing payment page
 */
router.get(
  '/public/:token',
  async (req, res: Response, next: NextFunction) => {
    try {
      const invoice = await prisma.invoice.findFirst({
        where: { publicToken: req.params.token, deletedAt: null },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          currency: true,
          totalAmount: true,
          paidAmount: true,
          dueDate: true,
          notes: true,
          memo: true,
          createdAt: true,
          customer: {
            select: { name: true, email: true },
          },
          workspace: {
            select: { name: true, email: true, logoUrl: true },
          },
          items: {
            select: { description: true, quantity: true, unitPrice: true, amount: true },
          },
          paymentLinks: {
            where: { isActive: true },
            select: { token: true, amount: true, currency: true },
          },
        },
      });

      if (!invoice) throw new NotFoundError('Invoice');
      sendSuccess(res, invoice);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/invoices/:id
 * Update a DRAFT invoice
 */
router.patch(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.invoice.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Invoice');
      if (existing.status !== 'DRAFT') {
        throw new ValidationError('Only draft invoices can be edited');
      }

      const { items, taxRate, discountAmount, ...rest } = req.body;
      let updateData: Record<string, unknown> = { ...rest };

      if (items) {
        const { subtotal, taxAmount, discount, total } = calculateInvoiceTotals(
          items, taxRate ?? 0, discountAmount ?? 0
        );
        updateData = { ...updateData, subtotal, taxAmount, discountAmount: discount, totalAmount: total };

        await prisma.invoiceItem.deleteMany({ where: { invoiceId: existing.id } });
        await prisma.invoiceItem.createMany({
          data: items.map((item: { description: string; quantity: number; unitPrice: number }) => ({
            invoiceId: existing.id,
            description: item.description,
            quantity: new Decimal(item.quantity),
            unitPrice: new Decimal(item.unitPrice),
            amount: new Decimal(item.quantity).times(new Decimal(item.unitPrice)),
          })),
        });
      }

      const invoice = await prisma.invoice.update({
        where: { id: param(req, "id") },
        data: updateData,
        include: { items: true, customer: true },
      });

      sendSuccess(res, invoice, 'Invoice updated');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/invoices/:id/send
 * Transitions invoice from DRAFT → PENDING and records issuedAt
 */
router.post(
  '/:id/send',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.invoice.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Invoice');
      if (existing.status !== 'DRAFT') {
        throw new ValidationError('Only draft invoices can be sent');
      }

      const invoice = await prisma.invoice.update({
        where: { id: param(req, "id") },
        data: { status: 'PENDING', issuedAt: new Date() },
      });

      sendSuccess(res, invoice, 'Invoice sent');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/invoices/:id/cancel
 */
router.post(
  '/:id/cancel',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.invoice.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Invoice');
      if (['PAID', 'CANCELLED'].includes(existing.status)) {
        throw new ValidationError('This invoice cannot be cancelled');
      }

      const invoice = await prisma.invoice.update({
        where: { id: param(req, "id") },
        data: { status: 'CANCELLED' },
      });

      sendSuccess(res, invoice, 'Invoice cancelled');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/invoices/:id (soft delete — DRAFT only)
 */
router.delete(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.invoice.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Invoice');
      if (existing.status !== 'DRAFT') {
        throw new ValidationError('Only draft invoices can be deleted');
      }

      await prisma.invoice.update({
        where: { id: param(req, "id") },
        data: { deletedAt: new Date() },
      });

      sendSuccess(res, null, 'Invoice deleted');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
