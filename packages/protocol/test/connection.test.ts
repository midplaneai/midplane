// A failed connection's code in words, as the gateway's prompts and the
// cloud's pages say it.

import { expect, it } from "vitest";
import { connectionErrorLine, connectionErrorSentence } from "../src/index.ts";

it("says what each known code means, and names any other", () => {
  expect(connectionErrorSentence("ECONNREFUSED")).toBe("connection refused");
  expect(connectionErrorSentence("ENOTFOUND")).toBe("host not found");
  expect(connectionErrorSentence("ETIMEDOUT")).toBe("connection timed out");
  expect(connectionErrorSentence("28P01")).toBe(
    "password authentication failed",
  );
  expect(connectionErrorSentence("28000")).toBe(
    "the server refused this role or host (pg_hba.conf)",
  );
  expect(connectionErrorSentence("3D000")).toBe("database does not exist");
  expect(connectionErrorSentence("42501")).toBe("permission denied");
  expect(connectionErrorSentence("XX000")).toBe("failed (XX000)");
  expect(connectionErrorSentence(null)).toBe("failed");
  // An inherited property is not a code.
  expect(connectionErrorSentence("constructor")).toBe("failed (constructor)");
});

it("puts the code after the words once", () => {
  expect(connectionErrorLine("28P01")).toBe(
    "password authentication failed (28P01)",
  );
  expect(connectionErrorLine("XX000")).toBe("failed (XX000)");
  expect(connectionErrorLine(null)).toBe("failed");
});
