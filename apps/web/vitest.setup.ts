import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Enable React act() environment for testing
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Next.js's "server-only" package throws when imported from a client context.
// In jsdom tests we don't have a server/client boundary — treat it as a no-op.
vi.mock("server-only", () => ({}));
