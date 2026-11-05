import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireWorkspace, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { param } from '../lib/params';
import { sendSuccess, sendCreated } from '../lib/response';
import { NotFoundError } from '../lib/errors';

const router = Router();

router.use(authenticate);

const customerSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  email: z.string().email().max(255).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  company: z.string().max(200).optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  stellarAddress: z.string().max(56).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

/**
 * GET /api/v1/customers?workspaceId=...
 */
router.get(
  '/',
  validate(listSchema, 'query'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      // workspaceId can come from query param or header
      const workspaceId = req.query.workspaceId as string || req.headers['x-workspace-id'] as string;
      if (!workspaceId) {
        res.status(400).json({ success: false, message: 'workspaceId is required' });
        return;
      }

      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 20;
      const search = req.query.search as string | undefined;

      const where = {
        workspaceId,
        deletedAt: null,
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { company: { contains: search, mode: 'insensitive' as const } },
          ],
        }),
      };

      const [customers, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            _count: { select: { invoices: true, payments: true } },
          },
        }),
        prisma.customer.count({ where }),
      ]);

      sendSuccess(
        res,
        customers,
        undefined,
        200,
        { page, limit, total, totalPages: Math.ceil(total / limit) }
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/customers
 */
router.post(
  '/',
  validate(customerSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.body.workspaceId || req.headers['x-workspace-id'] as string;
      if (!workspaceId) {
        res.status(400).json({ success: false, message: 'workspaceId is required' });
        return;
      }

      const customer = await prisma.customer.create({
        data: { ...req.body, workspaceId },
      });

      sendCreated(res, customer, 'Customer created');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/customers/:id
 */
router.get(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const customer = await prisma.customer.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
        include: {
          invoices: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
          payments: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      });

      if (!customer) throw new NotFoundError('Customer');
      sendSuccess(res, customer);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/customers/:id
 */
router.patch(
  '/:id',
  validate(customerSchema.partial()),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.customer.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Customer');

      const customer = await prisma.customer.update({
        where: { id: param(req, "id") },
        data: req.body,
      });
      sendSuccess(res, customer, 'Customer updated');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/customers/:id (soft delete)
 */
router.delete(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const existing = await prisma.customer.findFirst({
        where: { id: param(req, "id"), workspaceId, deletedAt: null },
      });
      if (!existing) throw new NotFoundError('Customer');

      await prisma.customer.update({
        where: { id: param(req, "id") },
        data: { deletedAt: new Date() },
      });
      sendSuccess(res, null, 'Customer deleted');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
