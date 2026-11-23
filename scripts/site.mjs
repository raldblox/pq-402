/**
 * Builds the demo page's data and the images, from the recorded run.
 *
 *   node scripts/site.mjs
 *
 * 1. site/run.json (written by `pnpm demo`) becomes site/run.js, so the page
 *    also works from file://.
 * 2. Headless Chrome screenshots site/index.html (site/shot.png).
 * 3. The cover (assets/cover.png, 1600 x 900) and the social preview
 *    (site/social.png, 1280 x 640) are composed from the claim, three lines of
 *    proof taken from the recorded run, and that screenshot.
 *
 * Chrome is found at CHROME_PATH or in the usual install locations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const site = join(root, "site");
const assets = join(root, "assets");
mkdirSync(assets, { recursive: true });

const run = JSON.parse(readFileSync(join(site, "run.json"), "utf8"));
writeFileSync(join(site, "run.js"), `window.PQ402_RUN = ${JSON.stringify(run)};\n`);

const chrome = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!chrome) throw new Error("no Chrome found; set CHROME_PATH");

function screenshot(file, out, width, height) {
  const profile = mkdtempSync(join(tmpdir(), "pq402-shot-"));
  const res = spawnSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      "--virtual-time-budget=3000",
      pathToFileURL(file).href,
    ],
    { stdio: "pipe", timeout: 60_000 },
  );
  rmSync(profile, { recursive: true, force: true });
  if (!existsSync(out)) throw new Error(`screenshot failed: ${res.stderr?.toString().slice(0, 400)}`);
  console.log(`wrote ${out}`);
}

screenshot(join(site, "index.html"), join(site, "shot.png"), 1000, 1250);

const settlement = (scheme) => run.transactions.find((t) => t.what.includes(`(${scheme})`))?.hash ?? "";
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "not recorded");
const proof = [
  `Paid from an escrow (pq-erc20): ${short(settlement("pq-erc20"))}`,
  `Paid from an on-chain agent budget (pq-perennial): ${short(settlement("pq-perennial"))}`,
  "Answers sealed with ML-KEM-1024 to the payer's registered key; receipts signed with ML-DSA-87",
];

function compose(width, height, out) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111314;color:#e8e8e4;
    font-family:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif}
  .wrap{display:grid;grid-template-columns:1fr ${Math.round(width * 0.42)}px;height:100%}
  .left{padding:${Math.round(height * 0.09)}px ${Math.round(width * 0.045)}px;display:flex;flex-direction:column;justify-content:center}
  .tag{color:#5cc4a6;font-weight:700;letter-spacing:.08em;font-size:${Math.round(height * 0.028)}px;margin-bottom:${Math.round(height * 0.03)}px}
  h1{font-size:${Math.round(height * 0.062)}px;line-height:1.18;margin:0 0 ${Math.round(height * 0.05)}px;font-weight:700}
  ul{list-style:none;padding:0;margin:0}
  li{font-size:${Math.round(height * 0.024)}px;line-height:1.45;color:#c9ccce;margin:0 0 ${Math.round(height * 0.018)}px;padding-left:22px;position:relative}
  li::before{content:"";position:absolute;left:0;top:.55em;width:10px;height:10px;border-radius:2px;background:#5cc4a6}
  .foot{margin-top:${Math.round(height * 0.05)}px;font-size:${Math.round(height * 0.02)}px;color:#8b9196}
  .right{background:#1b1f21;border-left:1px solid #2a2e31;overflow:hidden;position:relative}
  .right img{position:absolute;top:${Math.round(height * 0.06)}px;left:${Math.round(width * 0.025)}px;width:${Math.round(width * 0.42 - 2 * width * 0.025)}px;
    border-radius:10px;box-shadow:0 18px 50px rgba(0,0,0,.55)}
  </style></head><body><div class="wrap"><div class="left">
  <div class="tag">PQ-402</div>
  <h1>Pay for an API call with a post-quantum signature; get an answer only you can read.</h1>
  <ul>${proof.map((p) => `<li>${p}</li>`).join("")}</ul>
  <div class="foot">QoreChain testnet · recorded ${run.recordedAt.slice(0, 10)} · github.com/raldblox/pq-402 · npm @pq402</div>
  </div><div class="right"><img src="${pathToFileURL(join(site, "shot.png")).href}"></div></div></body></html>`;
  const tmp = join(site, `.compose-${width}.html`);
  writeFileSync(tmp, html);
  screenshot(tmp, out, width, height);
  rmSync(tmp);
}

compose(1600, 900, join(assets, "cover.png"));
compose(1280, 640, join(site, "social.png"));
