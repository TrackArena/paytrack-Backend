import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../lib/errors';
import { logger } from '../lib/logger';

const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET!;
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET!;
const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_EXPIRY || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '7d';

export interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  workspaceName: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// ============================================================
// Password Hashing
// ============================================================

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,   // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// ============================================================
// Token Generation
// ============================================================

export function generateAccessToken(payload: {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
}): string {
  return jwt.sign(payload, ACCESS_TOKEN_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY as jwt.SignOptions['expiresIn'],
    issuer: 'paytrack',
    audience: 'paytrack-api',
  });
}

export function generateRefreshToken(): string {
  return uuidv4() + '-' + uuidv4();
}

export function verifyAccessToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, ACCESS_TOKEN_SECRET, {
    issuer: 'paytrack',
    audience: 'paytrack-api',
  }) as jwt.JwtPayload;
}

// ============================================================
// Auth Operations
// ============================================================

export async function register(
  input: RegisterInput,
  ipAddress?: string,
  userAgent?: string
) {
  const existing = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase().trim() },
  });

  if (existing) {
    throw new ConflictError('An account with this email already exists');
  }

  if (input.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  const passwordHash = await hashPassword(input.password);
  const emailVerifyToken = uuidv4();

  // Create user + workspace + membership in a single transaction
  const result = await prisma.$transaction(async (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => {
    const user = await tx.user.create({
      data: {
        email: input.email.toLowerCase().trim(),
        passwordHash,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        emailVerifyToken,
      },
    });

    // Generate unique workspace slug
    const baseSlug = input.workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const slug = `${baseSlug}-${Date.now().toString(36)}`;

    const workspace = await tx.workspace.create({
      data: {
        name: input.workspaceName.trim(),
        slug,
      },
    });

    await tx.workspaceMember.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        role: 'OWNER',
      },
    });

    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        action: 'auth.register',
        entityType: 'User',
        entityId: user.id,
        ipAddress,
        userAgent,
      },
    });

    return { user, workspace };
  });

  logger.info('User registered', {
    userId: result.user.id,
    workspaceId: result.workspace.id,
  });

  return result;
}

export async function login(
  input: LoginInput,
  ipAddress?: string,
  userAgent?: string
): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;
  workspace: Awaited<ReturnType<typeof prisma.workspace.findFirst>>;
  tokens: TokenPair;
}> {
  const foundUser = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase().trim(), deletedAt: null },
  });

  if (!foundUser) {
    // Use constant-time comparison-equivalent delay to prevent user enumeration
    await hashPassword('dummy-comparison-prevent-timing-attack');
    throw new AuthenticationError('Invalid email or password');
  }

  const passwordValid = await verifyPassword(foundUser.passwordHash, input.password);
  if (!passwordValid) {
    throw new AuthenticationError('Invalid email or password');
  }

  // Get primary workspace (first workspace where user is OWNER)
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId: foundUser.id, workspace: { deletedAt: null } },
    include: { workspace: true },
    orderBy: { joinedAt: 'asc' },
  });

  const primaryWorkspace = membership?.workspace;

  // Generate tokens
  const accessToken = generateAccessToken({
    sub: foundUser.id,
    email: foundUser.email,
    firstName: foundUser.firstName,
    lastName: foundUser.lastName,
  });
  const refreshTokenValue = generateRefreshToken();

  // Store refresh token
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.refreshToken.create({
    data: {
      token: refreshTokenValue,
      userId: foundUser.id,
      expiresAt,
      userAgent,
      ipAddress,
    },
  });

  // Update last login
  await prisma.user.update({
    where: { id: foundUser.id },
    data: { lastLoginAt: new Date() },
  });

  logger.info('User logged in', { userId: foundUser.id });

  return {
    user: foundUser,
    workspace: primaryWorkspace ?? null,
    tokens: { accessToken, refreshToken: refreshTokenValue },
  };
}

export async function refreshTokens(
  refreshToken: string,
  ipAddress?: string,
  userAgent?: string
): Promise<TokenPair> {
  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
    include: { user: true },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AuthenticationError('Invalid or expired refresh token');
  }

  // Rotate the refresh token (revoke old, issue new)
  const newRefreshToken = generateRefreshToken();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    }),
    prisma.refreshToken.create({
      data: {
        token: newRefreshToken,
        userId: stored.userId,
        expiresAt,
        userAgent,
        ipAddress,
      },
    }),
  ]);

  const accessToken = generateAccessToken({
    sub: stored.user.id,
    email: stored.user.email,
    firstName: stored.user.firstName,
    lastName: stored.user.lastName,
  });

  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(refreshToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { token: refreshToken },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
