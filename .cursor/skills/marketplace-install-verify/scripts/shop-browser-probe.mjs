// Loads a Shop page in headless Chromium, signed out, and records which hosts the running client
// talks to. Read-only: nothing is clicked and no storage is written outside the throwaway profile.
import { join } from 'node:path';
import { requireOptional } from './resolve-deps.mjs';

export async function runShopBrowserProbe({ get, origin, path, service, nexus, forbiddenHosts, out, record }) {
  const host = new URL(origin).host;
  const id = `browser.${host}`;
  let chromium;
  try {
    ({ chromium } = requireOptional(get, 'playwright'));
  } catch (error) {
    return record(id, 'FAIL', 'Shop renders in Chromium', error.message, 'install the repository dependencies and run "npx playwright install chromium"');
  }
  const browser = await chromium.launch({ headless: true });
  const responses = [];
  const failures = [];
  const corsErrors = [];
  try {
    const page = await browser.newPage();
    page.on('response', (response) => {
      try {
        responses.push({ host: new URL(response.url()).host, status: response.status() });
      } catch {
        // non-URL responses (data:, blob:) carry no host
      }
    });
    page.on('requestfailed', (request) => {
      try {
        failures.push(new URL(request.url()).host);
      } catch {
        // ignored, as above
      }
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && /CORS|Access-Control-Allow-Origin/i.test(message.text())) corsErrors.push(message.text().slice(0, 160));
    });
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(
      () => !/^\s*Loading\.{0,3}\s*$/.test(document.body?.innerText ?? '') && (document.body?.innerText ?? '').length > 40,
      null,
      { timeout: 120_000 },
    );
    const nexusHost = nexus ? new URL(nexus).host : null;
    const deadline = Date.now() + Number(get('BROWSER_SETTLE_S') ?? 20) * 1000;
    while (Date.now() < deadline && nexusHost && !responses.some((r) => r.host === nexusHost && r.status < 400)) await page.waitForTimeout(1000);
    await page.waitForTimeout(3000);
    if (out) await page.screenshot({ path: join(out, `browser-${host}.png`), fullPage: false });
    const hosts = [...new Set(responses.map((r) => r.host).filter(Boolean))];
    record(`${id}.hosts`, 'INFO', 'hosts contacted', hosts.join(', '));
    for (const [label, target] of [['Nexus', nexus], ['marketplace service', service]]) {
      if (!target) continue;
      const targetHost = new URL(target).host;
      const seen = responses.filter((r) => r.host === targetHost);
      const bad = seen.filter((r) => r.status >= 500).length + failures.filter((h) => h === targetHost).length;
      if (!seen.length && label === 'marketplace service')
        record(`${id}.service`, 'INFO', 'marketplace service not called while signed out', 'expected on a signed-out board');
      else if (!seen.length)
        record(`${id}.${label === 'Nexus' ? 'nexus' : 'service'}`, 'FAIL', `client reads from the ${label}`, 'no request reached it', `the running client is configured for another ${label}; check the Shop runtime config`);
      else
        record(`${id}.${label === 'Nexus' ? 'nexus' : 'service'}`, bad ? 'FAIL' : 'PASS', `client reads from the ${label}`, `${seen.length} responses, ${bad} failed`, `read the ${label} log for the failing requests`);
    }
    const leftovers = hosts.filter((h) => forbiddenHosts.some((f) => h.toLowerCase().includes(f)));
    if (forbiddenHosts.length)
      record(`${id}.forbidden`, leftovers.length ? 'FAIL' : 'PASS', 'no requests to retired hosts', leftovers.join(', '), 'replace the retired host in the Shop runtime config');
    record(`${id}.cors`, corsErrors.length ? 'FAIL' : 'PASS', 'no CORS errors in the console', corsErrors[0] ?? '', 'allow the Shop origin on the service named in the error');
  } catch (error) {
    record(id, 'FAIL', 'Shop renders in Chromium', error.message.split('\n')[0], 'open the page in a browser and read the console');
  } finally {
    await browser.close();
  }
}
