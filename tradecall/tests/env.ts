process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://textback:textback_dev@localhost:5432/tradecall_test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-123456";
process.env.PUBLIC_URL = "https://app.tradecall.test";
process.env.RUN_WORKER = "false";
