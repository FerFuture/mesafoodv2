import crypto from "crypto";
import { QZ_PRIVATE_KEY } from "./privateKey.js";

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function requestToSign(req) {
  if (typeof req.body === "string" && req.body) return req.body;
  if (req.body && typeof req.body.request === "string") return req.body.request;
  const raw = await readStream(req);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.request === "string") return parsed.request;
  } catch {
    return raw;
  }
  return raw;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("POST");
    return;
  }
  const toSign = await requestToSign(req);
  if (!toSign) {
    res.status(400).send("empty");
    return;
  }
  const signer = crypto.createSign("SHA512");
  signer.update(toSign, "utf8");
  signer.end();
  const signature = signer.sign(QZ_PRIVATE_KEY, "base64");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(signature);
}
