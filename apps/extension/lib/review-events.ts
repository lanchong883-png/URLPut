const channelName = 'urlput-submission-review-changed';

export function notifySubmissionReviewChanged() {
  window.dispatchEvent(new Event(channelName));
  const channel = new BroadcastChannel(channelName);
  try { channel.postMessage(null); }
  finally { channel.close(); }
}

export function observeSubmissionReviews(refresh: () => void) {
  const channel = new BroadcastChannel(channelName);
  channel.addEventListener('message', refresh);
  window.addEventListener(channelName, refresh);
  return () => {
    channel.close();
    window.removeEventListener(channelName, refresh);
  };
}
