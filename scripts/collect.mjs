import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const versionsPath = join(root, "versions.json");
const MIN_MAJOR = 115;

const CHROME_URL =
  "https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions";
const EDGE_PRODUCTS_URL =
  "https://edgeupdates.microsoft.com/api/products?view=enterprise";
const EDGE_ARCHIVE_URL =
  "https://learn.microsoft.com/en-us/deployedge/microsoft-edge-relnote-archive-stable-channel";

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function keepLatest(map, version) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) return;
  const major = Number(version.split(".")[0]);
  if (major < MIN_MAJOR) return;
  const key = String(major);
  if (!map[key] || compareVersions(version, map[key]) > 0) {
    map[key] = version;
  }
}

function sortMap(map) {
  return Object.fromEntries(
    Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b)
      .map((major) => [String(major), map[String(major)]]),
  );
}

async function readExisting() {
  try {
    const parsed = JSON.parse(await readFile(versionsPath, "utf8"));
    return {
      chrome: parsed.chrome && typeof parsed.chrome === "object" ? parsed.chrome : {},
      edge: parsed.edge && typeof parsed.edge === "object" ? parsed.edge : {},
    };
  } catch (error) {
    if (error && error.code === "ENOENT") return { chrome: {}, edge: {} };
    throw error;
  }
}

async function fetchChrome() {
  const found = {};
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url = new URL(CHROME_URL);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Chrome version history HTTP ${response.status}`);
    }
    const data = await response.json();
    const versions = (data.versions || []).map((item) => item.version).filter(Boolean);
    for (const version of versions) keepLatest(found, version);
    const oldest = versions[versions.length - 1];
    if (!data.nextPageToken || !oldest || Number(oldest.split(".")[0]) < MIN_MAJOR) {
      break;
    }
    pageToken = data.nextPageToken;
  }
  if (!Object.keys(found).length) {
    throw new Error("Chrome version history returned no versions");
  }
  return found;
}

async function fetchEdgeEnterprise() {
  const response = await fetch(EDGE_PRODUCTS_URL);
  if (!response.ok) {
    throw new Error(`Edge products HTTP ${response.status}`);
  }
  const products = await response.json();
  const stable = products.find((product) => product.Product === "Stable");
  const found = {};
  for (const release of stable?.Releases || []) {
    if (release.Platform === "Windows" && release.Architecture === "x64") {
      keepLatest(found, release.ProductVersion);
    }
  }
  return found;
}

async function fetchEdgeArchive() {
  const response = await fetch(EDGE_ARCHIVE_URL);
  if (!response.ok) {
    throw new Error(`Edge release notes HTTP ${response.status}`);
  }
  const html = await response.text();
  const found = {};
  for (const match of html.matchAll(/Version\s+(\d+\.\d+\.\d+\.\d+)/g)) {
    keepLatest(found, match[1]);
  }
  return found;
}

async function main() {
  const existing = await readExisting();
  const chrome = { ...existing.chrome };
  const edge = { ...existing.edge };
  const merge = (target, source) => {
    for (const version of Object.values(source)) keepLatest(target, version);
  };

  try {
    merge(chrome, await fetchChrome());
  } catch (error) {
    console.error("Chrome fetch failed, keeping existing entries:", error.message);
    if (!Object.keys(chrome).length) throw error;
  }

  try {
    merge(edge, await fetchEdgeEnterprise());
  } catch (error) {
    console.error("Edge enterprise fetch failed:", error.message);
  }

  try {
    merge(edge, await fetchEdgeArchive());
  } catch (error) {
    console.error("Edge archive fetch failed:", error.message);
  }

  const next = {
    updated: new Date().toISOString().slice(0, 10),
    chrome: sortMap(chrome),
    edge: sortMap(edge),
  };
  const previous = {
    chrome: sortMap(existing.chrome),
    edge: sortMap(existing.edge),
  };
  if (
    JSON.stringify(previous.chrome) === JSON.stringify(next.chrome) &&
    JSON.stringify(previous.edge) === JSON.stringify(next.edge)
  ) {
    console.log("No version changes");
    return;
  }

  await writeFile(versionsPath, JSON.stringify(next, null, 2) + "\n");
  console.log(
    `Updated chrome ${Object.keys(next.chrome).length}, edge ${Object.keys(next.edge).length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
