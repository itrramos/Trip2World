import { type ApiError, ApiErrorCode } from '@trip2world/types';
import type { z, ZodError } from 'zod';

/**
 * Turn a ZodError into the field-keyed shape the API contract promises.
 *
 * Errors are grouped by dot-path so a form can render each message beside its input
 * without the client re-deriving anything. Messages are the ones authored in the schemas,
 * which are written to be shown to users verbatim.
 */
export function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '_';
    (details[path] ??= []).push(issue.message);
  }

  return details;
}

export function toApiError(error: ZodError, requestId?: string): ApiError {
  return {
    code: ApiErrorCode.VALIDATION_ERROR,
    message: 'Some of the information provided is not valid.',
    details: formatZodError(error),
    ...(requestId ? { requestId } : {}),
  };
}

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ApiError };

/**
 * Parse untrusted input into a typed value or a ready-to-send API error.
 *
 * Used at every HTTP and WebSocket boundary. Returning a result rather than throwing
 * keeps validation failures — which are ordinary, expected traffic — out of the
 * exception path and out of the error logs.
 */
export function parseInput<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  requestId?: string,
): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: toApiError(result.error, requestId) };
}

/**
 * Compact single-line summary for realtime error frames, where the client only needs to
 * know the payload was rejected and a full field map would be noise.
 */
export function summarizeZodError(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid payload';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}
