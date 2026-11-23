import { startBridge, type Bridge } from './bridge';
import { injectHook } from './eme/capture';

// Capture starts here, when DevTools opens; the panel page only loads once its tab is selected.
const bridge = startBridge();

// EME calls are recorded by a hook in the page. Attach it as soon as DevTools opens and again
// on every new document, so DRM playback is logged without a reload.
injectHook();
chrome.devtools.network.onNavigated.addListener(injectHook);

type PanelWindow = Window & { __isobmffBridge?: Bridge; __isobmffReady?: () => void };

chrome.devtools.panels.create('Media Stream Inspector', '', 'panel.html', (panel) => {
  panel.onShown.addListener((win) => {
    const w = win as PanelWindow;
    w.__isobmffBridge = bridge;
    w.__isobmffReady?.(); // set by the panel script; if it has not run yet, it picks the bridge up itself
    bridge.setVisible(true);
  });
  panel.onHidden.addListener(() => bridge.setVisible(false));
});
