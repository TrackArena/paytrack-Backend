import { Request } from 'express';

/**
 * Extract a route param as a guaranteed string.
 * Express types req.params as Record<string, string>, but occasionally
 * the compiler widens to string | string[]. This helper ensures a string.
 */
export function param(req: Request, name: string): string {
  const val = req.params[name];
  return Array.isArray(val) ? val[0] : (val as string);
}
