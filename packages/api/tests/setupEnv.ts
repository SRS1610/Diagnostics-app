// tests/setupEnv.ts
//
// Runs before the test framework is installed, so the env is populated
// before any module reads it — middleware/auth.ts and
// middleware/technicianAuth.ts both read JWT_SECRET at import time and
// throw when it's absent.
//
// DATABASE_URL points at a DEDICATED test database. It must never be the
// dev database: the fixtures here truncate every table between test
// files, which would silently destroy development data. The guard below
// makes that a hard failure rather than a surprise.

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-only-secret-not-used-outside-tests";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://diagnostics:diagnostics_dev@localhost:5432/diagnostics_test";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL)) {
  throw new Error(
    `Refusing to run tests against "${process.env.DATABASE_URL}" — the database name must end in _test, ` +
      "because the test fixtures truncate every table.",
  );
}
