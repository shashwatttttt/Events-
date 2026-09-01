import { afterEach, vi } from "vitest";

process.env.APP_MODE = "test";
process.env.DATA_PROVIDER = "local";
process.env.NEXT_PUBLIC_SITE_URL = "http://localhost:3000";
process.env.APP_TIMEZONE = "Australia/Melbourne";
process.env.APP_CURRENCY = "AUD";
process.env.AUTH_SECRET = "test-auth-secret-that-is-at-least-32-chars";
process.env.TICKET_TOKEN_SECRET = "test-ticket-secret-that-is-at-least-32-chars";

const deniedFetch = vi.fn(async () => {
  throw new Error("NETWORK_ACCESS_DENIED_IN_TESTS");
});

vi.stubGlobal("fetch", deniedFetch);

afterEach(() => {
  deniedFetch.mockClear();
});
