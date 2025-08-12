// Node 18+ needed (global fetch). Run server first: npm start
import assert from "node:assert/strict";

const BASE = "http://localhost:3000";

async function get(path) {
  const res = await fetch(BASE + path);
  assert.ok(res.ok, `GET ${path} -> ${res.status}`);
  return res.json();
}
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  assert.ok(res.ok, `POST ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
function log(ok, msg) {
  console.log(`${ok ? "✅" : "❌"} ${msg}`);
}

(async () => {
  // 0) encodings + price presets
  const meta = await get("/api/encodings");
  assert.ok(Array.isArray(meta.encodings) && meta.encodings.includes("gpt2"));
  assert.ok(meta.defaultPriceInrPerK && typeof meta.defaultPriceInrPerK.gpt2 === "number");
  log(true, "Encodings + price presets loaded");

  // 1) js-tiktoken: encode baseline
  const text = "Hello I am Manoj";
  const base = await post("/api/tokenize", { text, encodingName: "gpt2" });
  assert.ok(Array.isArray(base.tokenIds) && base.tokenIds.length > 0);
  log(true, `tiktoken encode ok (${base.tokenIds.length} tokens)`);

  // 2) js-tiktoken: custom token reduces count
  const withCustom = await post("/api/tokenize", { text, encodingName: "gpt2", customTokens: ["Manoj"] });
  assert.ok(withCustom.counts.tokens < base.counts.tokens, "custom token should reduce token count");
  log(true, "custom special token counts as one");

  // 3) js-tiktoken: round-trip decode
  const dec = await post("/api/decode", { tokenIds: base.tokenIds, encodingName: "gpt2" });
  assert.equal(dec.text, text);
  log(true, "tiktoken round-trip decode matches");

  // 4) Custom BPE: train
  const trainText = "Manoj lives in Maharashtra. Manoj codes a lot. Maharashtra is big.";
  const trained = await post("/api/custom/train", { text: trainText, vocabSize: 300, specials: ["<NAME>", "<CITY>"] });
  assert.ok(trained.ok, "training should succeed");
  log(true, `custom BPE trained (vocab ~${trained.vocabSize}, merges ${trained.merges})`);

  // 5) Custom BPE: encode/decode with specials
  const custText = "My name is <NAME> from <CITY>.";
  const custEnc = await post("/api/custom/encode", { text: custText });
  assert.ok(Array.isArray(custEnc.tokenIds) && custEnc.tokenIds.length > 0);
  const custDec = await post("/api/custom/decode", { tokenIds: custEnc.tokenIds });
  assert.equal(custDec.text, custText);
  log(true, "custom BPE round-trip with specials ok");

  // 6) Base charset coverage (uppercase, digits, punctuation)
  const edgeText = "Hello FROM 414001!";
  const e1 = await post("/api/custom/encode", { text: edgeText });
  const d1 = await post("/api/custom/decode", { tokenIds: e1.tokenIds });
  assert.equal(d1.text, edgeText);
  log(true, "custom BPE handles unseen chars (base charset) ok");

  console.log("\n🎉 All tests passed!");
})().catch(err => {
  console.error("\n❌ Test failed:", err.message || err);
  process.exit(1);
});
