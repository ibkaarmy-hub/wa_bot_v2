// Local stand-in for the Meta Graph API. Records every send and answers like Meta would.
// Usage: node scripts/meta-stub.mjs [port]   (default 4010). Sends are appended to scripts/.meta-stub-sends.jsonl
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const port = Number(process.argv[2] ?? 4010);
let n = 0;
createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && /\/messages$/.test(req.url ?? "")) {
      const id = `wamid.stub.${++n}`;
      const rec = { t: new Date().toISOString(), url: req.url, auth: req.headers.authorization ? "present" : "missing", body: JSON.parse(body || "{}"), id };
      appendFileSync("scripts/.meta-stub-sends.jsonl", JSON.stringify(rec) + "\n");
      const tplText = rec.body.type === "template" ? `${rec.body.template?.name} ${JSON.stringify(rec.body.template?.components?.[0]?.parameters?.map(p => p.text) ?? [])}` : JSON.stringify(rec.body.text?.body).slice(0, 80);
      console.log(`[meta-stub] ${rec.body.type} -> ${rec.body.to} ${tplText}`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id }] }));
    }
    res.writeHead(404); res.end("not found");
  });
}).listen(port, () => console.log(`[meta-stub] listening on ${port}`));
