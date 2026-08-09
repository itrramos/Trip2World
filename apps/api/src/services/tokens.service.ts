import { TokenError, TokenErrorCode, TokensService } from '@trip2world/database';
import { Errors, type AppError } from '../errors.js';

/**
 * The ledger itself lives in `@trip2world/database` because the realtime server needs it
 * too — tipping happens during a call, over the socket. This module only translates its
 * transport-agnostic errors into HTTP ones.
 */
export { TokensService, TokenError, TokenErrorCode };

/** Map a TokenError onto the API's error vocabulary. */
export function toApiError(error: unknown): AppError {
  if (!(error instanceof TokenError)) {
    return Errors.internal({ reason: 'UNEXPECTED_TOKEN_ERROR' });
  }

  switch (error.code) {
    case TokenErrorCode.INSUFFICIENT_FUNDS:
    case TokenErrorCode.SELF_TIP:
    case TokenErrorCode.ALREADY_ANSWERED:
    case TokenErrorCode.NO_OFFER:
      return Errors.conflict(error.message);
    case TokenErrorCode.INVALID_AMOUNT:
      return Errors.validation({ tokens: [error.message] });
    case TokenErrorCode.FORBIDDEN:
      return Errors.forbidden(error.message);
    case TokenErrorCode.NOT_FOUND:
      return Errors.notFound('That item');
    default:
      return Errors.internal();
  }
}
