import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { getEncoding, encodingForModel } from "js-tiktoken";
import { BPETokenizer } from "./tokenizer.js";
import fs from "fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.static("public"));

const DATA_DIR = path.join(__dirname, "data");
await fs.mkdir(DATA_DIR, { recursive: true });
const MODEL_PATH = path.join(DATA_DIR, "custom_tokenizer.json");

const KNOWN_ENCODINGS = ["cl100k_base", "o200k_base", "p50k_base", "r50k_base", "gpt2"];

// ---- js-tiktoken helpers ----
function buildExtendedSpecial(customTokens = []) {
    const map = {};
    let base = 200000; // high range to avoid collisions

    const add = (s) => {
        if (!s) return;
        if (map[s] == null) map[s] = base++;
    };

    for (const raw of (customTokens || [])) {
        const t = String(raw || "").trim();
        if (!t) continue;

        add(t);          // exact text
        add(" " + t);    // leading space variant (GPT-2 style)
    }

    return map;
}

function getEnc(encodingName, modelName, extendedSpecial) {
    if (modelName) { try { return encodingForModel(modelName, extendedSpecial); } catch { } }
    return getEncoding(encodingName, extendedSpecial);
}

// ---- metadata ----
app.get("/api/encodings", (req, res) => {
    res.json({
        encodings: KNOWN_ENCODINGS,
        defaultPriceInrPerK: { cl100k_base: 0.50, o200k_base: 5.00, p50k_base: 2.00, r50k_base: 2.00, gpt2: 1.00 }
    });
});

// ---- js-tiktoken encode/decode ----
app.post("/api/tokenize", (req, res) => {
    try {
        const { text = "", encodingName = "cl100k_base", modelName = null, customTokens = [] } = req.body || {};
        const rawCustom = Array.isArray(customTokens) ? customTokens : (typeof customTokens === "string" ? customTokens.split(",") : []);
        const customList = rawCustom.map(s => String(s).trim()).filter(Boolean);
        const extendedSpecial = buildExtendedSpecial(customList);
        const enc = getEnc(encodingName, modelName, extendedSpecial);
        const allowedSpecial = new Set(Object.keys(extendedSpecial));
        const tokenIds = enc.encode(text, allowedSpecial);
        const tokenTexts = tokenIds.map(id => enc.decode([id]));
        const characters = text.length;
        res.json({
            encodingName, modelName,
            customTokens: Object.keys(extendedSpecial),
            counts: { characters, tokens: tokenIds.length, avgCharsPerToken: tokenIds.length ? characters / tokenIds.length : 0 },
            items: tokenIds.map((id, i) => ({ id, text: tokenTexts[i] })), tokenIds
        });
    } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

app.post("/api/decode", (req, res) => {
    try {
        const { tokenIds = [], encodingName = "cl100k_base" } = req.body || {};
        const enc = getEncoding(encodingName);
        const ids = (Array.isArray(tokenIds) ? tokenIds : String(tokenIds).split(/[\s,]+/)).map(n => +n).filter(Number.isFinite);
        res.json({ text: enc.decode(ids) });
    } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

// ---- CUSTOM BPE: train / encode / decode ----
let CUSTOM = null;
async function ensureLoaded() {
    try { if (!CUSTOM) CUSTOM = await BPETokenizer.load(MODEL_PATH); } catch { }
}

app.post("/api/custom/train", async (req, res) => {
    try {
        const { text = "", vocabSize = 1000, specials = [] } = req.body || {};
        const tokenizer = await BPETokenizer.train(text, { vocabSize, specials });
        await tokenizer.save(MODEL_PATH);
        CUSTOM = tokenizer;
        res.json({ ok: true, vocabSize: tokenizer.tok2id.size, merges: tokenizer.merges.length, specials: tokenizer.specials });
    } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

app.get("/api/custom/status", async (req, res) => {
    await ensureLoaded();
    if (!CUSTOM) return res.json({ trained: false });
    res.json({ trained: true, vocabSize: CUSTOM.tok2id.size, merges: CUSTOM.merges.length, specials: CUSTOM.specials });
});

app.post("/api/custom/encode", async (req, res) => {
    try {
        await ensureLoaded();
        if (!CUSTOM) return res.status(400).json({ error: "No custom tokenizer trained yet." });
        const { text = "" } = req.body || {};
        const { ids, tokens } = CUSTOM.encode(text);
        res.json({
            tokenIds: ids,
            items: ids.map((id, i) => ({ id, text: tokens[i] ?? CUSTOM.id2tok[id] })),
            counts: { tokens: ids.length, characters: text.length, avgCharsPerToken: ids.length ? text.length / ids.length : 0 }
        });
    } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

app.post("/api/custom/decode", async (req, res) => {
    try {
        await ensureLoaded();
        if (!CUSTOM) return res.status(400).json({ error: "No custom tokenizer trained yet." });
        const ids = (Array.isArray(req.body?.tokenIds) ? req.body.tokenIds : String(req.body?.tokenIds || "").split(/[\s,]+/))
            .map(n => +n).filter(Number.isFinite);
        res.json({ text: CUSTOM.decode(ids) });
    } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Token Playground running on http://localhost:${PORT}`));
