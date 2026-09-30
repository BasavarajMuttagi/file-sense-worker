import { vi } from "vitest";

export interface MockAuthState {
  userId: string | null;
  sessionId: string | null;
}

export const authState: MockAuthState = {
  userId: "user_test_123",
  sessionId: "sess_test_123",
};

export function setMockUser(
  userId: string | null,
  sessionId: string | null = "sess_test_123",
) {
  authState.userId = userId;
  authState.sessionId = sessionId;
}

export function resetMockUser() {
  authState.userId = "user_test_123";
  authState.sessionId = "sess_test_123";
}

export function createMockAuth(options: Partial<MockAuthState> = {}) {
  const { userId = "user_test_123", sessionId = "sess_test_123" } = options;
  return {
    userId,
    sessionId,
    getToken: vi.fn().mockResolvedValue("mock-jwt-token"),
    claims: userId ? { sub: userId } : null,
  };
}
