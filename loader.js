'use strict';

const pluginApiUrl = 'https://docs.getgrist.com/grist-plugin-api.js';
const startup = document.getElementById('startup');
const flight = document.getElementById('flight');
const error = document.getElementById('error');
let frame;
let widgetWindow;
let installedOptions;
let failed = false;

const deadline = setTimeout(() => {
  fail('加载超时，请重新打开组件。', 'Loading timed out. Reopen the widget.');
}, 10_000);

function fail(chinese, english) {
  failed = true;
  clearTimeout(deadline);
  widgetWindow = undefined;
  frame?.remove();
  startup.hidden = false;
  flight.hidden = true;
  error.textContent = `${chinese} ${english}`;
  error.hidden = false;
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

  frame?.remove();
  frame = document.createElement('iframe');
  frame.id = 'widget';
  frame.title = 'Group Desk';
  document.body.prepend(frame);
  widgetWindow = frame.contentWindow;

  try {
    // Match Builder's about:blank frame and parser-inserted script order.
    const child = widgetWindow;
    const content = child.document;
    content.open();
    content.addEventListener('DOMContentLoaded', () => {
      if (child !== widgetWindow) return;
      if (!child.grist) {
        fail('无法加载 Grist 接口。', 'Could not load the Grist API.');
        return;
      }
      clearTimeout(deadline);
      startup.hidden = true;
    }, { once: true });

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
