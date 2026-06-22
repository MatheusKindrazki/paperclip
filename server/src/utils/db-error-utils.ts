/**
 * Database error utilities for detecting and handling specific error conditions.
 */

/**
 * Detect if a Postgres error is a foreign-key constraint violation
 * on a specific constraint.
 *
 * @param err - The error object from a database operation
 * @param constraintName - The exact name of the constraint to check
 * @returns true if the error is a FK violation on the specified constraint
 */
export function isForeignKeyViolation(
  err: unknown,
  constraintName: string,
): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = maybe.constraint ?? maybe.constraint_name;
  return maybe.code === "23503" && constraint === constraintName;
}
