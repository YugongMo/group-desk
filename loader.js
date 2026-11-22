'use strict';

const pluginApiUrl = 'https://docs.getgrist.com/grist-plugin-api.js';
const startup = document.getElementById('gd-launch-cover');
const panel = startup.querySelector('.gd-boot-panel');
const error = document.getElementById('error');
let frame;
let widgetWindow;
let installedOptions;
let failed = false;
let stopWatching;

const deadline = setTimeout(() => {
  fail('加载超时，请重新打开组件。', 'Loading timed out. Reopen the widget.');
}, 10_000);

function fail(chinese, english) {
  failed = true;
  clearTimeout(deadline);
  stopWatching?.();
  widgetWindow = undefined;
  frame?.remove();
  document.body.append(startup);
  panel.hidden = true;
  error.textContent = `${chinese} ${english}`;
  error.hidden = false;
}

function watchBootCover(child, content) {
  let pendingFrame;
  let fallback;
  let fallbackExpired = false;

  function stop() {
    observer.disconnect();
    child.cancelAnimationFrame(pendingFrame);
    clearTimeout(fallback);
  }

  function reveal() {
    stop();
    clearTimeout(deadline);
    startup.remove();
  }

  function check() {
    const cover = content.getElementById('gd-boot-cover');
    if (pendingFrame !== undefined || !cover || !child.grist) return;

    // Keep boot's first frame still while the launcher is covering it.
    const animations = cover.getAnimations({ subtree: true }).filter(
      animation => animation.animationName === 'gdBootFloat' || animation.animationName === 'gdLoad'
    );
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 0;
    }

    pendingFrame = child.requestAnimationFrame(() => {
      pendingFrame = child.requestAnimationFrame(() => {
        pendingFrame = undefined;
        if (!cover.isConnected) {
          check();
          if (fallbackExpired && pendingFrame === undefined) reveal();
          return;
        }
        reveal();
        for (const animation of animations) animation.play();
      });
    });
  }

  const observer = new MutationObserver(check);
  if (startup.isConnected) observer.observe(content, { childList: true, subtree: true });
  stopWatching = stop;

  content.addEventListener('DOMContentLoaded', () => {
    if (child !== widgetWindow) return;
    if (!child.grist) {
      fail('无法加载 Grist 接口。', 'Could not load the Grist API.');
      return;
    }
    clearTimeout(deadline);
    if (!startup.isConnected) return;
    check();
    fallback = setTimeout(() => {
      fallbackExpired = true;
      if (pendingFrame === undefined) reveal();
    }, 3_000);
  }, { once: true });
}

function render(options) {
  if (failed) return;
  const html = options?._html;
  const code = options?._js;
  if (typeof html !== 'string' || typeof code !== 'string' || !code.trim()) {
    if (!installedOptions) {
      fail('无法读取组件代码。', 'Could not read widget code.');
    }
    return;
  }
  if (html === installedOptions?.html && code === installedOptions?.code) return;
  installedOptions = { html, code };

  stopWatching?.();
  frame?.remove();
  frame = document.createElement('iframe');
  frame.id = 'widget';
  frame.title = document.title;
  document.body.prepend(frame);
  widgetWindow = frame.contentWindow;

  try {
    // Match Builder's about:blank frame and parser-inserted script order.
    const child = widgetWindow;
    const content = child.document;
    content.open();
    watchBootCover(child, content);

    content.write(html);
    if (!html.includes('grist-plugin-api.js')) {
      content.write(`<script src="${pluginApiUrl}"></script>`);
    }
    content.write(`<script>${code}</script>`);
    content.close();
  } catch {
    fail('无法启动组件。', 'Could not start the widget.');
  }
}

window.addEventListener('message', (event) => {
  if (!widgetWindow) return;
  if (event.source === widgetWindow) {
    window.parent.postMessage(event.data, '*');
  } else if (event.source === window.parent) {
    widgetWindow.postMessage(event.data, '*');
  }
});

const api = document.createElement('script');
api.src = pluginApiUrl;
api.onerror = () => fail('无法加载 Grist 接口。', 'Could not load the Grist API.');
api.onload = () => {
  if (failed) return;
  try {
    // As in Builder, leave access and column mapping requests to the child.
    window.grist.onOptions(render);
    window.grist.rpc.sendReadyMessage();
  } catch {
    fail('无法连接 Grist。', 'Could not connect to Grist.');
  }
};
document.head.append(api);
