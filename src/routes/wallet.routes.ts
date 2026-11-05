import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { validate } from '../middleware/validate';
import { prisma } from '../lib/prisma';
import { param } from '../lib/params';
import { sendSuccess, sendCreated } from '../lib/response';
import { NotFoundError, ValidationError } from '../lib/errors';
import { StellarService } from '../services/stellar/stellar.service';

const router = Router();
router.use(authenticate);

const stellar = new StellarService();

// Stellar public key validation (G-address, 56 chars, base32)
const stellarPublicKeyRegex = /^G[A-Z0-9]{55}$/;

const connectWalletSchema = z.object({
  workspaceId: z.string().uuid(),
  publicKey: z.string().regex(stellarPublicKeyRegex, 'Invalid Stellar public key format'),
  label: z.string().max(100).optional(),
  network: z.enum(['testnet', 'mainnet']).default('testnet'),
});

/**
 * POST /api/v1/wallets/connect
 * Register a Stellar public address for monitoring — never stores secret keys
 */
router.post(
  '/connect',
  validate(connectWalletSchema),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, publicKey, label, network } = req.body;

      // Verify the account exists on the Stellar network
      const accountExists = await stellar.getAccountInfo(publicKey, network);
      if (!accountExists) {
        throw new ValidationError(
          'Stellar account not found on the network. Please fund the account first.'
        );
      }

      const existing = await prisma.stellarWallet.findFirst({
        where: { workspaceId, publicKey, network },
      });
      if (existing) {
        throw new ValidationError('This wallet is already connected to this workspace');
      }

      const wallet = await prisma.stellarWallet.create({
        data: { workspaceId, publicKey, label, network },
      });

      await prisma.auditLog.create({
        data: {
          workspaceId,
          userId: req.user!.id,
          action: 'wallet.connected',
          entityType: 'StellarWallet',
          entityId: wallet.id,
          newData: { publicKey, network },
        },
      });

      sendCreated(res, wallet, 'Wallet connected successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/wallets?workspaceId=...
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

      const wallets = await prisma.stellarWallet.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
      });

      sendSuccess(res, wallets);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/wallets/:id
 */
router.get(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const wallet = await prisma.stellarWallet.findFirst({
        where: { id: param(req, "id"), workspaceId },
      });
      if (!wallet) throw new NotFoundError('Wallet');

      sendSuccess(res, wallet);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/wallets/:id/transactions
 * Fetches recent transactions from Horizon for this wallet
 */
router.get(
  '/:id/transactions',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const wallet = await prisma.stellarWallet.findFirst({
        where: { id: param(req, "id"), workspaceId },
      });
      if (!wallet) throw new NotFoundError('Wallet');

      const limit = parseInt(req.query.limit as string || '20', 10);
      const transactions = await stellar.getAccountTransactions(
        wallet.publicKey,
        wallet.network as 'testnet' | 'mainnet',
        limit
      );

      sendSuccess(res, transactions);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * DELETE /api/v1/wallets/:id
 */
router.delete(
  '/:id',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.headers['x-workspace-id'] as string;
      const wallet = await prisma.stellarWallet.findFirst({
        where: { id: param(req, "id"), workspaceId },
      });
      if (!wallet) throw new NotFoundError('Wallet');

      await prisma.stellarWallet.update({
        where: { id: param(req, "id") },
        data: { isActive: false, isMonitored: false },
      });

      sendSuccess(res, null, 'Wallet disconnected');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
