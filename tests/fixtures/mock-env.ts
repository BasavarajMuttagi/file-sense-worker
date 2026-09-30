export const createMockEnv = (overrides?: Partial<Env>): Env => ({
  UPSTASH_VECTOR_REST_URL: "https://mock-vector.upstash.io",
  UPSTASH_VECTOR_REST_TOKEN: "mock-vector-token",
  CLERK_PUBLISHABLE_KEY: "pk_test_mock",
  CLERK_SECRET_KEY: "sk_test_mock",
  TIGRIS_STORAGE_ACCESS_KEY_ID: "mock-access-key-id",
  TIGRIS_STORAGE_SECRET_ACCESS_KEY: "mock-secret-access-key",
  TIGRIS_STORAGE_ENDPOINT: "https://mock.storage.dev",
  TIGRIS_STORAGE_BUCKET: "mock-bucket",
  SARVAM_API_KEY: "mock-sarvam-key",
  DATABASE_URL: "libsql://mock.turso.io",
  TOKEN: "mock-turso-token",
  MISTRAL_API_KEY: "mock-mistral-key",
  UPSTASH_BOX_API_KEY: "mock-box-key",
  ...overrides,
});

export const MOCK_ENV: Env = createMockEnv();
