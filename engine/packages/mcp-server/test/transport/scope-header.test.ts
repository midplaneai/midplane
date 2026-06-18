// X-Midplane-Scope header parser — tolerance + fail-closed contract.

import { describe, expect, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";

import {
  SCOPE_HEADER,
  parseMcpScopeHeader,
} from "../../src/transport/scope-header.ts";

const h = (value: string | string[] | undefined): IncomingHttpHeaders =>
  value === undefined ? {} : { [SCOPE_HEADER]: value };

describe("parseMcpScopeHeader", () => {
  test("absent header → null (no scope = full access)", () => {
    expect(parseMcpScopeHeader(undefined)).toBeNull();
    expect(parseMcpScopeHeader({})).toBeNull();
  });

  test("valid JSON object → SessionScope map", () => {
    const scope = parseMcpScopeHeader(h('{"main":"read","analytics":"write"}'));
    expect(scope).not.toBeNull();
    expect(scope!.size).toBe(2);
    expect(scope!.get("main")).toBe("read");
    expect(scope!.get("analytics")).toBe("write");
  });

  test("empty object → empty map (scope active, zero DBs — deny all)", () => {
    const scope = parseMcpScopeHeader(h("{}"));
    expect(scope).not.toBeNull();
    expect(scope!.size).toBe(0);
  });

  // ── Fail-closed: present-but-malformed → empty map, NEVER null ──────────────
  test("malformed JSON → empty map (fail closed)", () => {
    const scope = parseMcpScopeHeader(h("{not json"));
    expect(scope).not.toBeNull();
    expect(scope!.size).toBe(0);
  });

  test("duplicated header (string[]) → empty map (fail closed)", () => {
    const scope = parseMcpScopeHeader(h(['{"main":"read"}', '{"main":"write"}']));
    expect(scope!.size).toBe(0);
  });

  test("non-object JSON (string / array / number) → empty map", () => {
    expect(parseMcpScopeHeader(h('"main"'))!.size).toBe(0);
    expect(parseMcpScopeHeader(h('["main"]'))!.size).toBe(0);
    expect(parseMcpScopeHeader(h("123"))!.size).toBe(0);
    expect(parseMcpScopeHeader(h("null"))!.size).toBe(0);
  });

  test("invalid access value → empty map (whole header voided)", () => {
    // The valid sibling entry must NOT survive — a corrupt grant can't
    // silently narrow to "the valid part only".
    expect(parseMcpScopeHeader(h('{"main":"read","x":"admin"}'))!.size).toBe(0);
    expect(parseMcpScopeHeader(h('{"main":"read_write"}'))!.size).toBe(0); // grant levels are read|write
  });

  test("invalid DB name → empty map", () => {
    expect(parseMcpScopeHeader(h('{"Main":"read"}'))!.size).toBe(0); // uppercase
    expect(parseMcpScopeHeader(h('{"__default__":"read"}'))!.size).toBe(0); // reserved shape
    expect(parseMcpScopeHeader(h('{"":"read"}'))!.size).toBe(0); // empty
  });

  test("blank / overlong value → empty map", () => {
    expect(parseMcpScopeHeader(h("   "))!.size).toBe(0);
    expect(parseMcpScopeHeader(h("x".repeat(20_000)))!.size).toBe(0);
  });
});
