import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { AuthenticationError } from '../lib/errors.js';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  workspaceId?: string;
  workspaceRole?: string;
}

export function authenticate(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    const tokenFromHeader = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    const tokenFromCookie = req.cookies?.access_token as string | undefined;
    const token = tokenFromHeader || tokenFromCookie;

    if (!token) {
      throw new AuthenticationError('No authentication token provided');
    }

    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      throw new Error('JWT_ACCESS_SECRET not configured');
    }

    const decoded = jwt.verify(token, secret) as {
      sub: string;
      email: string;
      firstName: string;
      lastName: string;
    };

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      firstName: decoded.firstName,
      lastName: decoded.lastName,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AuthenticationError('Token expired'));
    } else if (error instanceof jwt.JsonWebTokenError) {
      next(new AuthenticationError('Invalid token'));
    } else {
      next(error);
    }
  }
}

export function requireWorkspace(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  const rawId = req.params.workspaceId || req.headers['x-workspace-id'];
  const workspaceId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!workspaceId) {
    return next(new AuthenticationError('Workspace ID is required'));
  }

  if (!req.user) {
    return next(new AuthenticationError('Authentication required'));
  }

  const userId = req.user.id;

  prisma.workspaceMember
    .findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      include: { workspace: { select: { deletedAt: true } } },
    })
    .then((member: { role: string; workspace: { deletedAt: Date | null } } | null) => {
      if (!member || member.workspace.deletedAt) {
        return next(new AuthenticationError('Access to this workspace is not authorised'));
      }
      req.workspaceId = workspaceId;
      req.workspaceRole = member.role;
      next();
    })
    .catch(next);
}

export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.workspaceRole || !roles.includes(req.workspaceRole)) {
      next(new AuthenticationError('Insufficient permissions for this action'));
    } else {
      next();
    }
  };
}
