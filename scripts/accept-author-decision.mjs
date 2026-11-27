import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

// Called by accept-research.py decision-continuity for each author confirmation.
const [origin, directory, serialized, author, phase] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.ok(![9321, 9322].includes(Number(new URL(origin).port)), 'Use an isolated Sth service');
const proposal = JSON.parse(serialized);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const confirmations = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/web/invoke') && request.postDataJSON()?.operationId === 'decision.confirm') {
      confirmations.push(request.postDataJSON());
    }
  });
  await page.goto(`${origin}/author-context?projectId=${encodeURIComponent(proposal.projectId)}`);
  const pending = page.getByRole('region', { name: '待确认提案', exact: true });
  await pending.getByText(proposal.body, { exact: true }).waitFor();
  await page.getByLabel('作者署名', { exact: true }).fill(author);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/web/invoke')
    && response.request().postDataJSON()?.operationId === 'decision.confirm');
  await pending.getByRole('button', { name: '确认这一版', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const receipt = await response.json();
  assert.equal(receipt.operationId, 'decision.confirm');
  assert.equal(receipt.replayed, false);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].stepId, receipt.stepId);
  assert.deepEqual(confirmations[0].input, { decisionId: proposal.decisionId,
    expectedRevision: proposal.revision, proposalRevision: proposal.revision,
    authorConfirmed: true, confirmedBy: author });
  const confirmed = page.getByRole('region', { name: '作者已确认', exact: true });
  await confirmed.getByText(proposal.body, { exact: true }).waitFor();
  await page.reload();
  await confirmed.getByText(proposal.body, { exact: true }).waitFor();
  const fixedHref = await page.getByRole('link', { name: '固定此版本', exact: true }).getAttribute('href');
  assert.equal(Number(new URL(fixedHref, origin).searchParams.get('revision')), receipt.result.contextRevision);
  assert.equal(await pending.getByRole('button', { name: '确认这一版', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(directory, `${phase}.png`), fullPage: true });
  await writeFile(join(directory, `${phase}.json`), JSON.stringify({ request: confirmations[0], receipt,
    fixedHref, reloaded: true, viewportWidth: 390 }, null, 2), { mode: 0o600 });
} finally {
  await browser.close();
}
