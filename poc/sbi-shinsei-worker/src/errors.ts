export class UnsafeReadRequestError extends Error {
  override name = "UnsafeReadRequestError";
}

export class UnverifiedReadRouteError extends Error {
  override name = "UnverifiedReadRouteError";
}

export class UnknownResponseShapeError extends Error {
  override name = "UnknownResponseShapeError";
}

export class ResponseTooLargeError extends Error {
  override name = "ResponseTooLargeError";
}

export class AuthenticationBoundaryError extends Error {
  override name = "AuthenticationBoundaryError";
}

export class JscAcquisitionError extends Error {
  override name = "JscAcquisitionError";
}

export class LoginResponseError extends Error {
  override name = "LoginResponseError";
}
