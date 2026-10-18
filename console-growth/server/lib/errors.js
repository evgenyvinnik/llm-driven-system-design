// Errors thrown by route handlers and libraries. The app's error handler turns them into
// `{ error: { type, message } }` responses with the given status.
export class ApiError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function badRequest(message, type = 'invalid_request') {
  return new ApiError(400, type, message);
}

export function notFound(message) {
  return new ApiError(404, 'not_found', message);
}
