/**
 * A refusal the Postgres listener answers as an ErrorResponse: a login or a users file that would not do
 * (src/duck/users.ts), with the HTTP-style status the listener maps to a SQLSTATE (src/api/postgres/server.ts
 * `sqlstateOf`) and a stable machine-readable code.
 */
export class ApiError extends Error {
  status: number;
  /** The STABLE machine-readable name of the failure (`invalid_user`, `users_unreadable`, ...), carried in the
   *  ErrorResponse's detail so a reader branches on it instead of parsing `message`. */
  code?: string | undefined;
  /** The user a refused `mason user` login asked for (src/duck/users.ts): its request-log row names it. */
  userName?: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
