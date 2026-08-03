module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setupEnv.ts"],
  testMatch: ["<rootDir>/tests/**/*.test.ts"],
  // These tests share one Postgres database and reset it between files,
  // so they cannot run concurrently — parallel workers would truncate
  // each other's fixtures mid-test.
  maxWorkers: 1,
  testTimeout: 20000,
};
