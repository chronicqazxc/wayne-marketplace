import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, modeFromEnv, redact, redactDeep } from "./index.ts";

test("card numbers: Luhn-valid masked, order numbers kept", () => {
  assert.equal(redact("card 4111 1111 1111 1111 ok").text, "card [REDACTED:CARD] ok");
  assert.equal(redact("card 4111-1111-1111-1111").text, "card [REDACTED:CARD]");
  assert.equal(redact("order 1234567890123456").text, "order 1234567890123456");
});

test("SSN and Taiwan national ID validated", () => {
  assert.equal(redact("ssn 123-45-6789").text, "ssn [REDACTED:SSN]");
  assert.equal(redact("ssn 000-12-3456").text, "ssn 000-12-3456");
  assert.equal(redact("id A123456789").text, "id [REDACTED:TW_ID]");
  assert.equal(redact("id A123456788").text, "id A123456788");
});

test("IBAN validated, trailing words survive", () => {
  assert.equal(redact("DE89 3704 0044 0532 0130 00").text, "[REDACTED:IBAN]");
  assert.equal(redact("pay DE89 3704 0044 0532 0130 00 TODAY").text, "pay [REDACTED:IBAN] TODAY");
  assert.equal(redact("DE00 3704 0044 0532 0130 00").text, "DE00 3704 0044 0532 0130 00");
});

test("secrets: tokens, private keys, password values", () => {
  assert.equal(redact("key AKIAIOSFODNN7EXAMPLE").text, "key [REDACTED:SECRET]");
  assert.equal(redact("token ghp_" + "a".repeat(36)).text, "token [REDACTED:SECRET]");
  assert.equal(redact("Your password is hunter2 thanks").text, "Your password is [REDACTED:SECRET] thanks");
  assert.equal(redact("密碼：abc123").text, "密碼：[REDACTED:SECRET]");
  assert.match(redact("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----").text, /^\[REDACTED:SECRET\]$/);
});

test("one-time codes", () => {
  assert.equal(redact("Your verification code is 482913.").text, "Your verification code is [REDACTED:OTP].");
  assert.equal(redact("驗證碼：123456").text, "驗證碼：[REDACTED:OTP]");
  assert.equal(redact("zip code 9").text, "zip code 9");
});

test("email and phone only in strict mode; dates untouched", () => {
  const t = "mail bob@example.com or +1 (415) 555-2671, 0912-345-678, on 2026-11-01 12:00";
  assert.equal(redact(t, "mask").text, t);
  assert.equal(
    redact(t, "strict").text,
    "mail [REDACTED:EMAIL] or [REDACTED:PHONE], [REDACTED:PHONE], on 2026-11-01 12:00",
  );
});

test("off mode is a no-op; counts are reported", () => {
  assert.equal(redact("4111 1111 1111 1111", "off").text, "4111 1111 1111 1111");
  assert.deepEqual(redact("4111111111111111 and 4111111111111111").counts, { CARD: 2 });
});

test("detect reports kinds without values", () => {
  assert.deepEqual(detect("pay 4111111111111111"), ["CARD"]);
  assert.deepEqual(detect("hello"), []);
});

test("redactDeep masks nested strings, skips listed keys, does not mutate", () => {
  const input = { id: "4111111111111111", from: "a@b.com", body: "card 4111111111111111", list: [{ s: "ssn 123-45-6789" }], n: 5 };
  const { value, counts } = redactDeep(input, { mode: "mask", skipKeys: ["id", "from"] });
  assert.deepEqual(value, {
    id: "4111111111111111",
    from: "a@b.com",
    body: "card [REDACTED:CARD]",
    list: [{ s: "ssn [REDACTED:SSN]" }],
    n: 5,
  });
  assert.deepEqual(counts, { CARD: 1, SSN: 1 });
  assert.equal(input.body, "card 4111111111111111");
});

test("modeFromEnv fails closed", () => {
  assert.equal(modeFromEnv({}, "X"), "mask");
  assert.equal(modeFromEnv({ X: "STRICT" }, "X"), "strict");
  assert.equal(modeFromEnv({ X: "off" }, "X"), "off");
  assert.equal(modeFromEnv({ X: "offf" }, "X"), "mask");
});
