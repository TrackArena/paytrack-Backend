import { Request, Response, NextFunction } from 'express';
import { ZodError, ZodIssue } from 'zod';
import { AppError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'Validation failed',
      code: 'VALIDATION_ERROR',
      errors: (err.issues || []).map((e: ZodIssue) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // Known application errors
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error('Non-operational error', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      });
    }

    const response: Record<string, unknown> = {
      success: false,
      message: err.message,
      code: err.code,
    };

    if (err instanceof ValidationError && err.errors) {
      response.errors = err.errors;
    }

    res.status(err.statusCode).json(response);
    return;
  }

  // Prisma errors
  const maybePrisma = err as unknown as Record<string, unknown>;
  if (typeof maybePrisma.code === 'string' && maybePrisma.code.startsWith('P')) {
    if (maybePrisma.code === 'P2002') {
      const meta = maybePrisma.meta as { target?: string[] } | undefined;
      res.status(409).json({
        success: false,
        message: 'A record with this value already exists',
        code: 'DUPLICATE_ENTRY',
        field: meta?.target?.[0],
      });
      return;
    }
    if (maybePrisma.code === 'P2025') {
      res.status(404).json({
        success: false,
        message: 'Record not found',
        code: 'NOT_FOUND',
      });
      return;
    }
  }

  // Unexpected errors — do not leak details in production
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : 'An unexpected error occurred',
    code: 'INTERNAL_ERROR',
  });
}
