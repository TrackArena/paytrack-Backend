import { Response } from 'express';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: unknown;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode: number = 200,
  meta?: ApiResponse['meta']
): Response {
  const response: Record<string, unknown> = { success: true, data };
  if (message) response.message = message;
  if (meta) response.meta = meta;
  return res.status(statusCode).json(response);
}

export function sendCreated<T>(res: Response, data: T, message?: string): Response {
  return sendSuccess(res, data, message, 201);
}

export function sendNoContent(res: Response): Response {
  return res.status(204).send();
}

export function sendError(
  res: Response,
  message: string,
  statusCode: number = 500,
  errors?: unknown,
  code?: string
): Response {
  const response: Record<string, unknown> = { success: false, message };
  if (errors) response.errors = errors;
  if (code) response.code = code;
  return res.status(statusCode).json(response);
}
