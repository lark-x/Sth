// Add failure evidence without retries, longer deadlines, or changed assertions.
export async function diagnoseRoute(page, action) {
  const requests = [];
  const failures = [];
  const pending = new Set();
  const requested = request => {
    if (request.resourceType() !== 'script' && !request.url().includes('/api/')) return;
    pending.add(request);
    requests.push(request.url());
  };
  const finished = request => pending.delete(request);
  const failed = request => {
    pending.delete(request);
    failures.push({ url: request.url(), error: request.failure()?.errorText });
  };
  const response = response => {
    if (response.status() >= 400) failures.push({ url: response.url(), status: response.status() });
  };
  page.on('request', requested);
  page.on('requestfinished', finished);
  page.on('requestfailed', failed);
  page.on('response', response);
  try {
    return await action();
  } catch (error) {
    let deadline;
    const fallback = () => ({ url: page.url(), unavailable: true });
    const document = await Promise.race([page.evaluate(() => ({
      url: location.href,
      pane: window.document.querySelector('.manuscript-frame')?.getAttribute('data-pane'),
      readyState: window.document.readyState,
      main: Boolean(window.document.querySelector('main')?.getClientRects().length),
      passage: Boolean(window.document.querySelector('#passage-body')),
      tools: Boolean(window.document.querySelector('.wr-reader-toolbar')),
      controls: [...window.document.querySelectorAll('.wr-compare-switch button')].map(node => ({
        text: node.textContent?.trim(), rect: node.getBoundingClientRect().toJSON(),
        display: getComputedStyle(node).display, visibility: getComputedStyle(node).visibility,
      })),
      messages: [...window.document.querySelectorAll('[role="status"], [role="alert"]')]
        .filter(node => node.getClientRects().length).map(node => node.textContent?.trim()),
    })).catch(fallback), new Promise(resolve => { deadline = setTimeout(() => resolve(fallback()), 1000); })])
      .finally(() => clearTimeout(deadline));
    throw new Error(`Route failed: ${JSON.stringify({ document, pending: [...pending].map(request => request.url()), failures, requests: requests.slice(-15) })}`, { cause: error });
  } finally {
    page.off('request', requested);
    page.off('requestfinished', finished);
    page.off('requestfailed', failed);
    page.off('response', response);
  }
}
