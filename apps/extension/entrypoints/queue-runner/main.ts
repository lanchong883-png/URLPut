import { browser } from 'wxt/browser';
import { runQueue } from '../../lib/check-queue';
import { directoryBinding, directoryPermission, readMultiSiteBatch } from '../../lib/local-directory';

browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== browser.runtime.id || message?.type !== 'urlput-queue-runner') return;
  void (async () => {
    const dir = await directoryBinding();
    if (!dir || await directoryPermission(dir) !== 'granted') throw new Error('后台尚无目录读写授权。请重新授权后继续队列。');
    if (!await readMultiSiteBatch(dir, message.batchId)) throw new Error('目录已切换，请在原工作空间继续队列。');
    const execution = runQueue(dir);
    reply({ ok: true });
    await execution;
  })().catch(error => {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});
