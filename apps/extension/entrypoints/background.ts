import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  const runner = '/queue-runner.html';
  let opening: Promise<void> | undefined;

  async function ensureRunner() {
    if (!opening) {
      opening = (async () => {
        const contexts = await browser.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [new URL(runner, self.location.href).href],
        });
        if (!contexts.length) await browser.offscreen.createDocument({
          url: runner,
          reasons: ['LOCAL_STORAGE'],
          justification: '在侧栏关闭后继续只读队列，并与其他扩展窗口共用持久化请求间隔及退避记录。',
        });
      })().finally(() => { opening = undefined; });
    }
    await opening;
  }

  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== browser.runtime.id || message?.type !== 'urlput-start-queue') return;
    void ensureRunner()
      .then(() => browser.runtime.sendMessage({ type: 'urlput-queue-runner', batchId: message.batchId }))
      .then(reply, error => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
  });
});
