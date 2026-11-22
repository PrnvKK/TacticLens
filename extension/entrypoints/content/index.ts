import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { h, render } from 'preact';
import { Badge, OVERLAY_CSS } from '../../components/Badge';
import { findLargestPlayingVideo } from '../../lib/video';
import { startBrain } from '../../lib/brain-bridge';

const HOST_ID = 'tacticlens-host';
const HOST_Z = 2147483647;

interface Session {
  host: HTMLElement;
  stopBrain: () => void;
  teardown: () => void;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let session: Session | null = null;

    function enable(): void {
      if (session) return;
      const video = findLargestPlayingVideo(document);

      const host = document.createElement('div');
      host.id = HOST_ID;
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      const mount = document.createElement('div');
      shadow.append(style, mount);
      render(
        h(Badge, { text: video ? 'TacticLens · Calibrating…' : 'TacticLens · No playing video' }),
        mount,
      );

      const layout = (): void => {
        // Fullscreen hides everything outside the fullscreen element's subtree,
        // so the host must live inside it. A <video> cannot hold children, so
        // for a bare fullscreen <video> the overlay stays in <body> (limitation).
        const fs = document.fullscreenElement;
        const parent = fs && fs.tagName !== 'VIDEO' ? fs : document.body;
        if (host.parentElement !== parent) parent.append(host);

        if (video) {
          const r = video.getBoundingClientRect();
          host.style.cssText =
            `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
            `pointer-events:none;z-index:${HOST_Z};`;
        } else {
          host.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${HOST_Z};`;
        }
      };

      const ro = video ? new ResizeObserver(layout) : null;
      if (video && ro) ro.observe(video);
      window.addEventListener('resize', layout);
      window.addEventListener('scroll', layout, { capture: true, passive: true });
      document.addEventListener('fullscreenchange', layout);
      layout();

      const s: Session = {
        host,
        stopBrain: () => {},
        teardown: () => {
          ro?.disconnect();
          window.removeEventListener('resize', layout);
          window.removeEventListener('scroll', layout, { capture: true });
          document.removeEventListener('fullscreenchange', layout);
        },
      };
      session = s;

      startBrain()
        .then((stop) => {
          s.stopBrain = stop;
          if (session !== s) stop(); // toggled off while the brain was booting
        })
        .catch((err) => console.warn('[TacticLens] brain failed to start', err));
    }

    function disable(): void {
      if (!session) return;
      session.teardown();
      session.stopBrain();
      session.host.remove();
      session = null;
    }

    browser.runtime.onMessage.addListener((msg: unknown) => {
      const m = msg as { type?: string; on?: boolean } | null;
      if (m?.type !== 'tl:toggle') return;
      if (m.on) enable();
      else disable();
    });
  },
});
