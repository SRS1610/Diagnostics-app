process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://textback:textback_dev@localhost:5432/textback_test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.TWILIO_AUTH_TOKEN = "test_auth_token";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_VALIDATE_SIGNATURES = "true";
process.env.PUBLIC_BASE_URL = "https://textback.test";
process.env.RUN_WORKER = "false";
