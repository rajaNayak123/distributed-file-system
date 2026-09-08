export class AppError extends Error {
  constructor(message, statusCode, errorCategory, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCategory = errorCategory;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTHENTICATION_ERROR');
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Not authorized to access this resource') {
    super(message, 403, 'AUTHORIZATION_ERROR');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicting state') {
    super(message, 409, 'CONFLICT');
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(message) {
    super(message, 409, 'INVALID_STATE_TRANSITION');
  }
}

export class UpstreamServiceError extends AppError {
  constructor(message = 'Upstream dependency failed', details) {
    super(message, 502, 'UPSTREAM_SERVICE_ERROR', details);
  }
}

export class IdempotencyPayloadMismatchError extends AppError {
  constructor(message = 'Idempotency-Key reused with a different request body') {
    super(message, 422, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  }
}

export class IdempotencyConflictError extends AppError {
  constructor(message = 'A request with this Idempotency-Key is already in progress') {
    super(message, 409, 'IDEMPOTENCY_IN_PROGRESS');
  }
}
