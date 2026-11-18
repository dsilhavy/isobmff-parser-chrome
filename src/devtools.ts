import { startBridge, type Bridge } from './bridge';

// Capture starts here, when DevTools opens; the panel page only loads once its tab is selected.
const bridge = startBridge();

type PanelWindow = Window & { __isobmffBridge?: Bridge; __isobmffReady?: () => void };

chrome.devtools.panels.create('ISOBMFF', '', 'panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    const w = win as PanelWindow;
    w.__isobmffBridge = bridge;
    w.__isobmffReady?.(); // set by the panel script; if it has not run yet, it picks the bridge up itself
    bridge.setVisible(true);
  });
  panel.onHidden.addListener(() => bridge.setVisible(false));
});
