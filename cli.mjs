#!/usr/bin/env node
import fs from "fs/promises";
import { BPETokenizer } from "./tokenizer.js";

const args = process.argv.slice(2);
const cmd = args[0];

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => data += c);
    process.stdin.on("end", () => resolve(data));
  });
}

async function main() {
  switch (cmd) {
    case "train": {
      const file = args[1];
      const vocab = Number(args[2] || 1000);
      const specials = (args[3] || "").split(",").map(s=>s.trim()).filter(Boolean);
      const text = file ? await fs.readFile(file, "utf8") : await readStdin();
      const tok = await BPETokenizer.train(text, { vocabSize: vocab, specials });
      await tok.save("custom_tokenizer.json");
      console.log(`Trained: vocab=${tok.tok2id.size}, merges=${tok.merges.length}`);
      break;
    }
    case "encode": {
      const text = args.slice(1).join(" ") || await readStdin();
      const tok = await BPETokenizer.load("custom_tokenizer.json");
      const { ids } = tok.encode(text);
      console.log(ids.join(","));
      break;
    }
    case "decode": {
      const tok = await BPETokenizer.load("custom_tokenizer.json");
      const ids = (args[1]||"").split(/[\s,]+/).map(x=>+x).filter(Number.isFinite);
      console.log(tok.decode(ids));
      break;
    }
    case "save": {
      const out = args[1] || "custom_tokenizer.json";
      const tok = await BPETokenizer.load("custom_tokenizer.json");
      await tok.save(out); console.log("saved ->", out); break;
    }
    case "load": {
      const file = args[1] || "custom_tokenizer.json";
      const tok = await BPETokenizer.load(file);
      await tok.save("custom_tokenizer.json");
      console.log("loaded <-", file); break;
    }
    default:
      console.log(`Usage:
  node cli.mjs train <file.txt> [vocabSize] [specialsCsv]
  node cli.mjs encode "your text here"
  node cli.mjs decode "1,2,3,4"
  node cli.mjs load custom_tokenizer.json
  node cli.mjs save out.json`);
  }
}
main();
