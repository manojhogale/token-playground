// tokenizer.js  (ESM)
import fs from "fs/promises";

/* ---------------- Base charset: avoid dropping unseen characters ---------------- */
function baseCharset() {
  const set = new Set();
  // printable ASCII
  for (let i = 32; i <= 126; i++) set.add(String.fromCharCode(i));
  // word-boundary marker
  set.add("▁");
  // a few common currency symbols
  ["₹", "€", "£", "$"].forEach(ch => set.add(ch));
  return set;
}

/* ---------------- Word splitter with "▁" marker; keeps specials intact ---------------- */
function wordsWithMarker(text, specialSet) {
  if (specialSet && specialSet.size) {
    const specials = [...specialSet]
      .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const re = new RegExp(`(${specials})`, "g");
    const parts = text.split(re).filter(Boolean);
    const out = [];
    for (const part of parts) {
      if (specialSet.has(part)) out.push(part);
      else out.push(...basicWords(part));
    }
    return out;
  }
  return basicWords(text);

  function basicWords(t) {
    return t
      .replace(/\r\n?/g, "\n")
      .split(/\s+/)
      .filter(w => w.length)
      .map(w => "▁" + w);
  }
}

const toChars = (w) => Array.from(w);

/* ---------------- BPE training helpers ---------------- */
function countPairs(corpus) {
  const freq = new Map();
  for (const tokens of corpus) {
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i] + " " + tokens[i + 1];
      freq.set(key, (freq.get(key) || 0) + 1);
    }
  }
  return freq;
}

function mergeCorpus(corpus, pair) {
  const [a, b] = pair.split(" ");
  const ab = a + b;
  for (let w = 0; w < corpus.length; w++) {
    const toks = corpus[w];
    const merged = [];
    for (let i = 0; i < toks.length; i++) {
      if (i < toks.length - 1 && toks[i] === a && toks[i + 1] === b) {
        merged.push(ab);
        i++;
      } else {
        merged.push(toks[i]);
      }
    }
    corpus[w] = merged;
  }
  return corpus;
}

/* ---------------- Standalone BPE apply (no `this` dependency) ---------------- */
function applyBPE(wordChars, rank) {
  if (wordChars.length < 2) return wordChars;
  let tokens = [...wordChars];
  while (tokens.length >= 2) {
    let minRank = Infinity, minIdx = -1;
    for (let i = 0; i < tokens.length - 1; i++) {
      const key = tokens[i] + " " + tokens[i + 1];
      const r = rank.get(key);
      if (r !== undefined && r < minRank) { minRank = r; minIdx = i; }
    }
    if (minIdx === -1) break;
    tokens.splice(minIdx, 2, tokens[minIdx] + tokens[minIdx + 1]);
  }
  return tokens;
}

/* ============================================================================== */

export class BPETokenizer {
  constructor({ vocab = new Map(), merges = [], specials = [] } = {}) {
    // vocab can be Map or plain object
    this.vocab = vocab instanceof Map ? vocab : new Map(Object.entries(vocab));
    this.merges = merges;          // array of [a,b]
    this.specials = specials;      // array of literal strings
    this.specialSet = new Set(specials);

    // rank: "a b" -> order index (lower = earlier merge)
    this.rank = new Map();
    for (let i = 0; i < this.merges.length; i++) {
      const m = this.merges[i];
      this.rank.set(m[0] + " " + m[1], i);
    }

    // id maps
    this.id2tok = [];
    this.tok2id = new Map();
    let idx = 0;
    for (const tok of this.vocab.keys()) {
      this.tok2id.set(tok, idx);
      this.id2tok[idx] = tok;
      idx++;
    }
    // append specials (ensure ids exist)
    for (const s of this.specials) {
      if (!this.tok2id.has(s)) {
        this.tok2id.set(s, idx);
        this.id2tok[idx] = s;
        idx++;
      }
    }
  }

  /* ---------------- Train from raw text ---------------- */
  static async train(text, { vocabSize = 1000, specials = [] } = {}) {
    const specialSet = new Set(specials);
    const words = wordsWithMarker(text, specialSet)
      .filter(t => !specialSet.has(t)); // don't learn from specials

    // start with characters
    let corpus = words.map(w => toChars(w));

    // initial vocab: all chars from corpus + base charset (coverage)
    const charSet = new Set();
    for (const w of corpus) for (const ch of w) charSet.add(ch);
    for (const ch of baseCharset()) charSet.add(ch);

    const vocab = new Map();
    for (const ch of charSet) vocab.set(ch, 1);

    const merges = [];
    while (vocab.size + merges.length < vocabSize) {
      const pairs = countPairs(corpus);
      if (pairs.size === 0) break;
      let bestPair = null, bestCount = 0;
      for (const [p, c] of pairs) if (c > bestCount) { bestCount = c; bestPair = p; }
      if (!bestPair) break;
      const [a, b] = bestPair.split(" ");
      merges.push([a, b]);
      vocab.set(a + b, 1);
      corpus = mergeCorpus(corpus, bestPair);
    }
    return new BPETokenizer({ vocab, merges, specials });
  }

  /* Optional instance method */
  bpe(wordChars) { return applyBPE(wordChars, this.rank); }

  /* ---------------- Encode: preserve spaces around specials; apply BPE ---------------- */
  encode(text) {
    const specialsRe = this.specials.length
      ? new RegExp("(" + this.specials.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "g")
      : null;
    const parts = specialsRe ? text.split(specialsRe).filter(Boolean) : [text];

    const outTokens = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isSpecial = this.specialSet.has(part);

      if (isSpecial) {
        // NOTE: no space marker added here; previous non-special chunk
        // adds a trailing "▁" if it ended with whitespace.
        outTokens.push(part);
        continue;
      }

      const endsWS = /\s$/.test(part);
      const words = wordsWithMarker(part); // adds "▁" at word starts
      for (const w of words) {
        const toks = applyBPE(toChars(w), this.rank);
        outTokens.push(...toks);
      }
      // if chunk ends with space and next is a special, add explicit space marker
      if (endsWS && i < parts.length - 1 && this.specialSet.has(parts[i + 1])) {
        outTokens.push("▁");
      }
    }

    const ids = outTokens.map(t => {
      const id = this.tok2id.get(t);
      if (id !== undefined) return id;
      // fallback to characters if token unseen
      return toChars(t).map(c => this.tok2id.get(c)).filter(x => x !== undefined);
    }).flat();

    return { ids, tokens: outTokens };
  }

  /* ---------------- Decode: clean spaces & punctuation ---------------- */
  decode(ids = []) {
    const toks = ids.map(id => this.id2tok[id]).filter(Boolean);
    let text = toks.join("").replace(/▁/g, " ").trimStart();
    // remove space before punctuation
    text = text.replace(/\s+([.,;:!?])/g, "$1");
    return text;
  }

  /* ---------------- Serialize ---------------- */
  toJSON() {
    return {
      vocab: Object.fromEntries(this.vocab.entries()),
      merges: this.merges,
      specials: this.specials
    };
  }
  static fromJSON(obj) { return new BPETokenizer(obj); }

  async save(path) { await fs.writeFile(path, JSON.stringify(this.toJSON(), null, 2), "utf8"); }
  static async load(path) {
    const raw = await fs.readFile(path, "utf8");
    return BPETokenizer.fromJSON(JSON.parse(raw));
  }
}
