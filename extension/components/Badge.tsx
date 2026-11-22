import type { JSX } from 'preact';
import { GLASS, GLASS_BACKDROP_LITE } from '../lib/render/tokens';

// Styles live inside the Shadow DOM, so page CSS cannot leak in (and vice versa).
// The badge is a shadow-root island, so it uses the frost-only glass stack (no SVG filter
// reference across the shadow boundary) with the same tint, rim and text shadow as the HUD.
export const OVERLAY_CSS = `
.tl-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #fff;
  background-color: ${GLASS.fill};
  background-image: ${GLASS.lift};
  border: 1px solid ${GLASS.edge};
  border-radius: 7px;
  padding: 7px 11px;
  letter-spacing: 0.02em;
  box-shadow: ${GLASS.shadowTight}, inset 0 1px 0 ${GLASS.innerLight};
  -webkit-backdrop-filter: ${GLASS_BACKDROP_LITE};
  backdrop-filter: ${GLASS_BACKDROP_LITE};
  text-shadow: ${GLASS.textShadow};
  pointer-events: none;
}
.tl-badge::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: ${GLASS.rim};
  opacity: .9;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
}
`;

export function Badge({ text }: { text: string }): JSX.Element {
  return <div class="tl-badge">{text}</div>;
}
