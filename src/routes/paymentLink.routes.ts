import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { sendSuccess, sendCreated } from '../lib/response';
import { NotFoundError } from '../lib/errors';

const router = Router();

const createLinkSchema = z.object({
  workspaceId: z.string().uuid(),
  invoiceId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  amount: z.coerce.number().positive().optional(),
  currency: z.string().length(3).default('USDC'),
  expiresAt: z.string().datetime().optional().nullable(),
});

/**
 * POST /api/v1/payment-links
 */
router.post(
  '/',
  authenticate,
  validate(createLinkSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const link = await prisma.paymentLink.create({
        data: {
          ...req.body,
          amount: req.body.amount ? req.body.amount.toString() : undefined,
        },
        include: {
          invoice: { select: { invoiceNumber: true, totalAmount: true, currency: true } },
        },
      });

      sendCreated(res, link, 'Payment link created');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/payment-links/:token
 * Public endpoint — customer-facing, no auth
 */
router.get(
  '/:token',
  async (req, res: Response, next: NextFunction) => {
    try {
      const link = await prisma.paymentLink.findUnique({
        where: { token: req.params.token },
        include: {
          workspace: { select: { name: true, email: true, logoUrl: true } },
          invoice: {
            select: {
              invoiceNumber: true,
              totalAmount: true,
              paidAmount: true,
              currency: true,
              status: true,
              dueDate: true,
              memo: true,
              items: {
                select: { description: true, quantity: true, unitPrice: true, amount: true },
              },
              customer: { select: { name: true, email: true } },
            },
          },
        },
      });

      if (!link) throw new NotFoundError('Payment link');

      // Increment view count
      await prisma.paymentLink.update({
        where: { token: req.params.token },
        data: { viewCount: { increment: 1 } },
      });

      // Check expiry
      if (link.expiresAt && link.expiresAt < new Date()) {
        res.status(410).json({ success: false, message: 'This payment link has expired' });
        return;
      }

      if (!link.isActive) {
        res.status(410).json({ success: false, message: 'This payment link is no longer active' });
        return;
      }

      sendSuccess(res, link);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
