import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';

export type RequestPart = 'body' | 'query' | 'params';

/**
 * Middleware factory for Zod-based request validation.
 * Throws a ZodError on failure, which is handled by errorHandler.
 */
export function validate(schema: ZodSchema, part: RequestPart = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req[part]);
      // Replace the request part with the parsed (and potentially transformed) value
      req[part] = parsed;
      next();
    } catch (error) {
      next(error);
    }
  };
}
