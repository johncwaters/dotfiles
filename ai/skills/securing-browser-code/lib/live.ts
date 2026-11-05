import { spawnSync } from "node:child_process";
import path from "node:path";
import type { TrackedFile } from "./audit.ts";
import { isTestOrFixture, parseJson, unsafeScriptSourceFailure } from "./generic.ts";

const SITES_FILE = ".browser-sdk-sites.json";
export const LOOPBACK_ALLOWANCE_VARIABLE = "SECURING_BROWSER_CODE_ALLOWS_LOOPBACK";

const FETCH_TIMEOUT_MS = 5000;
const CHILD_TIMEOUT_MS = FETCH_TIMEOUT_MS + 2000;
const ASTRO_CONFIG_PATTERN = /(?:^|\/)astro\.config\.(?:mjs|cjs|js|mts|ts)$/;
const ASTRO_SITE_PATTERN = /\bsite\s*:\s*["'`](https?:\/\/[^"'`\s]+)["'`]/;
const HOSTNAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const POLICY_FIX = "check which config the host actually reads (for Netlify, a _headers file in the publish directory always applies), redeploy, then confirm with curl -sI";
const MAX_REDIRECTS = 5;
const FETCH_SCRIPT = `
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
const refusedRanges = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]]) refusedRanges.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) refusedRanges.addSubnet(address, prefix, "ipv6");
if (process.env.${LOOPBACK_ALLOWANCE_VARIABLE} !== "1") {
  refusedRanges.addSubnet("127.0.0.0", 8, "ipv4");
  refusedRanges.addAddress("::1", "ipv6");
}
const signal = AbortSignal.timeout(${FETCH_TIMEOUT_MS});

async function refusedAddressOf(hostname) {
  const bareHostname = hostname.replace(/^\\[|\\]$/g, "");
  const addresses = isIP(bareHostname) ? [{ address: bareHostname, family: isIP(bareHostname) }] : await lookup(bareHostname, { all: true });
  for (const { address, family } of addresses) {
    const mappedIpv4 = address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : null;
    const isRefused = mappedIpv4 === null ? refusedRanges.check(address, family === 6 ? "ipv6" : "ipv4") : refusedRanges.check(mappedIpv4, "ipv4");
    if (isRefused) return address;
  }
  return null;
}

async function probe(siteUrl) {
  let hopUrl = new URL(siteUrl);
  for (let hop = 0; hop <= ${MAX_REDIRECTS}; hop += 1) {
    if (hopUrl.protocol !== "https:" && hopUrl.protocol !== "http:") return { url: siteUrl, error: "redirected to a non-http URL" };
    const refusedAddress = await refusedAddressOf(hopUrl.hostname);
    if (refusedAddress !== null) return { url: siteUrl, error: "refused the private address " + refusedAddress };
    const response = await fetch(hopUrl, { redirect: "manual", signal });
    await response.body?.cancel();
    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
    if (!isRedirect) return { url: siteUrl, headers: Object.fromEntries(response.headers) };
    hopUrl = new URL(location, hopUrl);
  }
  return { url: siteUrl, error: "more than ${MAX_REDIRECTS} redirects" };
}

const probes = process.argv.slice(1).map(async (siteUrl) => {
  try {
    return await probe(siteUrl);
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "no response within ${FETCH_TIMEOUT_MS / 1000}s" : String(error?.cause?.code ?? error?.code ?? error?.message ?? error);
    return { url: siteUrl, error: reason };
  }
});
process.stdout.write(JSON.stringify(await Promise.all(probes)));
`;

type SiteResponse = { url: string; headers: Record<string, string> } | { url: string; error: string };
type SiteUrls = { urls: string[]; problems: string[] };

export function probeLiveCsp(files: TrackedFile[], browserCodeDirectories: string[], mayProbe: () => boolean): string[] {
  const { urls, problems } = siteUrlsFor(files, browserCodeDirectories);
  if (urls.length === 0 && problems.length === 0) return [];
  if (!mayProbe()) return [];
  return [...problems, ...fetchAllHeaders(urls).flatMap(servedPolicyNotes)];
}

function siteUrlsFor(files: TrackedFile[], browserCodeDirectories: string[]): SiteUrls {
  const sitesFile = files.find((file) => file.path === SITES_FILE);
  if (sitesFile !== undefined) return listedSiteUrls(sitesFile);
  const inferredUrls = files.filter((file) => !isTestOrFixture(file.path)).flatMap((file) => inferredSiteUrls(file, browserCodeDirectories));
  return { urls: uniqueOrigins(inferredUrls), problems: [] };
}

function listedSiteUrls(sitesFile: TrackedFile): SiteUrls {
  const listed = parseJson(sitesFile.text);
  const isUrlList = Array.isArray(listed) && listed.every((entry) => typeof entry === "string" && originRoot(entry) !== null);
  if (!isUrlList) return { urls: [], problems: [`NOTE live-csp ${SITES_FILE} is not a JSON array of http(s) URLs, so no site was probed`] };
  return { urls: uniqueOrigins(listed), problems: [] };
}

function inferredSiteUrls(file: TrackedFile, browserCodeDirectories: string[]): string[] {
  const fileName = path.posix.basename(file.path);
  if (ASTRO_CONFIG_PATTERN.test(file.path)) return [ASTRO_SITE_PATTERN.exec(file.text)?.[1]].filter((url) => url !== undefined);
  if (fileName === "package.json") return browserCodeDirectories.includes(path.posix.dirname(file.path)) ? [homepageOf(file.text)].filter((url) => url !== null) : [];
  if (fileName !== "CNAME") return [];
  const hostname = file.text.split("\n")[0]?.trim() ?? "";
  return HOSTNAME_PATTERN.test(hostname) ? [`https://${hostname}`] : [];
}

function homepageOf(manifestText: string): string | null {
  const manifest = parseJson(manifestText);
  if (typeof manifest !== "object" || manifest === null || !("homepage" in manifest)) return null;
  return typeof manifest.homepage === "string" ? manifest.homepage : null;
}

function uniqueOrigins(urls: string[]): string[] {
  return [...new Set(urls.map(originRoot).filter((url) => url !== null))];
}

function originRoot(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/`;
}

function fetchAllHeaders(urls: string[]): SiteResponse[] {
  if (urls.length === 0) return [];
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", FETCH_SCRIPT, ...urls], { encoding: "utf8", timeout: CHILD_TIMEOUT_MS, env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  const responses = child.status === 0 ? parseJson(child.stdout) : null;
  if (Array.isArray(responses) && responses.length === urls.length) return responses as SiteResponse[];
  const reason = child.error?.message ?? (child.stderr.trim().split("\n").at(-1) || `probe exited ${child.status ?? child.signal}`);
  return urls.map((url) => ({ url, error: reason }));
}

function servedPolicyNotes(response: SiteResponse): string[] {
  if ("error" in response) return [`NOTE live-csp ${response.url} could not be reached (${response.error}), so the served policy is unverified`];
  const enforcedPolicy = response.headers["content-security-policy"];
  if (enforcedPolicy === undefined && response.headers["content-security-policy-report-only"] !== undefined) {
    return [`NOTE live-csp ${response.url} serves only Content-Security-Policy-Report-Only, so it blocks nothing. Fix: ${POLICY_FIX}`];
  }
  if (enforcedPolicy === undefined) {
    return [`NOTE live-csp ${response.url} serves no Content-Security-Policy header, so nothing limits what its pages load. Fix: ${POLICY_FIX}`];
  }
  const servedDeclaration = { path: response.url, line: 1, isReportOnly: false, policyText: enforcedPolicy, fileText: enforcedPolicy };
  return unsafeScriptSourceFailure(servedDeclaration).map((failure) => `NOTE live-csp ${response.url} serves a policy where ${failure.problem}. Fix: ${failure.fix}`);
}
