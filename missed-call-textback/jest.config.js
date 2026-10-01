/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  setupFiles: ["<rootDir>/tests/env.ts"],
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: { strict: true, esModuleInterop: true } }] },
};
