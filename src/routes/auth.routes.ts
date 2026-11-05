import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import * as authService from '../services/auth.service';
import { sendSuccess, sendCreated } from '../lib/response';

const router = Router();

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '10', 10),
  message: { success: false, message: 'Too many authentication attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// Validation Schemas
// ============================================================

const registerSchema = z.object({
  email: z.string().email('Invalid email address').max(255),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100, 'Password too long')
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/,
      'Password must contain uppercase, lowercase, and a number'
    ),
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  workspaceName: z.string().min(1).max(100).trim(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ============================================================
// Routes
// ============================================================

/**
 * POST /api/v1/auth/register
 * Register a new user and create their first workspace
 */
router.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, workspace } = await authService.register(
        req.body,
        req.ip,
        req.get('user-agent')
      );

      const accessToken = authService.generateAccessToken({
        sub: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      });
      const refreshToken = authService.generateRefreshToken();

      // Store refresh token
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const { prisma } = await import('../lib/prisma');
      await prisma.refreshToken.create({
        data: {
          token: refreshToken,
          userId: user.id,
          expiresAt,
          userAgent: req.get('user-agent'),
          ipAddress: req.ip,
        },
      });

      setRefreshCookie(res, refreshToken);

      sendCreated(res, {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          emailVerified: user.emailVerified,
        },
        workspace: workspace
          ? { id: workspace.id, name: workspace.name, slug: workspace.slug }
          : null,
        accessToken,
      }, 'Account created successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/auth/login
 */
router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, workspace, tokens } = await authService.login(
        req.body,
        req.ip,
        req.get('user-agent')
      );

      setRefreshCookie(res, tokens.refreshToken);

      sendSuccess(res, {
        user: {
          id: user!.id,
          email: user!.email,
          firstName: user!.firstName,
          lastName: user!.lastName,
          emailVerified: user!.emailVerified,
        },
        workspace: workspace
          ? { id: workspace.id, name: workspace.name, slug: workspace.slug }
          : null,
        accessToken: tokens.accessToken,
      }, 'Login successful');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/auth/refresh
 * Refresh access token using HTTP-only cookie
 */
router.post(
  '/refresh',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refreshToken = req.cookies?.refresh_token as string;
      if (!refreshToken) {
        res.status(401).json({ success: false, message: 'No refresh token' });
        return;
      }

      const tokens = await authService.refreshTokens(
        refreshToken,
        req.ip,
        req.get('user-agent')
      );

      setRefreshCookie(res, tokens.refreshToken);
      sendSuccess(res, { accessToken: tokens.accessToken }, 'Token refreshed');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/v1/auth/logout
 */
router.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const refreshToken = req.cookies?.refresh_token as string;
      if (refreshToken) {
        await authService.logout(refreshToken);
      }
      clearRefreshCookie(res);
      sendSuccess(res, null, 'Logged out successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user profile
 */
router.get(
  '/me',
  authenticate,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { prisma } = await import('../lib/prisma');
      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          emailVerified: true,
          createdAt: true,
          workspaceMembers: {
            include: {
              workspace: {
                select: { id: true, name: true, slug: true, currency: true },
              },
            },
            where: { workspace: { deletedAt: null } },
          },
        },
      });

      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }

      sendSuccess(res, {
        ...user,
        workspaces: user.workspaceMembers.map((m: { workspace: { id: string; name: string; slug: string; currency: string }; role: string }) => ({
          ...m.workspace,
          role: m.role,
        })),
        workspaceMembers: undefined,
      });
    } catch (error) {
      next(error);
    }
  }
);

// ============================================================
// Cookie Helpers
// ============================================================

function setRefreshCookie(res: Response, token: string) {
  res.cookie('refresh_token', token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: (process.env.COOKIE_SAME_SITE as 'strict' | 'lax' | 'none') || 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/api/v1/auth',
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie('refresh_token', { path: '/api/v1/auth' });
}

export default router;
