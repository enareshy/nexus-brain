import type { ErrorCode } from "./errors.js";

export interface ApiMeta {
  readonly requestId?: string;
  readonly total?: number;
  readonly page?: number;
  readonly limit?: number;
}

export interface ApiSuccess<T> {
  readonly success: true;
  readonly data: T;
  readonly error: null;
  readonly meta?: ApiMeta;
}

export interface ApiFailure {
  readonly success: false;
  readonly data: null;
  readonly error: { readonly code: ErrorCode; readonly message: string };
  readonly meta?: ApiMeta;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export function ok<T>(data: T, meta?: ApiMeta): ApiSuccess<T> {
  return meta ? { success: true, data, error: null, meta } : { success: true, data, error: null };
}

export function fail(code: ErrorCode, message: string, meta?: ApiMeta): ApiFailure {
  const error = { code, message };
  return meta
    ? { success: false, data: null, error, meta }
    : { success: false, data: null, error };
}
