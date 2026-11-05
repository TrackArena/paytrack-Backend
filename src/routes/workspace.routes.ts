import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireWorkspace, requireRole, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { sendSuccess, sendCreated } from '../lib/response';
import { NotFoundError } from '../lib/errors';

const router = Router();

router.use(authenticate);

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  website: z.string().url().optional().nullable(),
  address: z.string().max(255).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  country: z.string().max(100).optional().nullable(),
  currency: z.string().length(3).optional(),
});

/**
 * GET /api/v1/workspaces/:workspaceId
 */
router.get(
  '/:workspaceId',
  requireWorkspace,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: req.workspaceId!, deletedAt: null },
        include: {
          members: {
            include: {
              user: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
          },
          _count: {
            select: {
              customers: { where: { deletedAt: null } },
              invoices: { where: { deletedAt: null } },
            },
          },
        },
      });

      if (!workspace) throw new NotFoundError('Workspace');
      sendSuccess(res, workspace);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * PATCH /api/v1/workspaces/:workspaceId
 */
router.patch(
  '/:workspaceId',
  requireWorkspace,
  requireRole('OWNER', 'ADMIN'),
  validate(updateWorkspaceSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspace = await prisma.workspace.update({
        where: { id: req.workspaceId! },
        data: req.body,
      });
      sendSuccess(res, workspace, 'Workspace updated');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
