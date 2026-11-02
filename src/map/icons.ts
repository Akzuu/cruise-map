import type { BoatIconId } from '../types';

/**
 * Top-down boat icons, all drawn pointing north (up) in a 48×48 box. They use
 * currentColor for the fill so the boat colour setting applies, plus a dark
 * outline so they stay readable on both satellite and light maps.
 */
const OUTLINE = 'stroke="#10222f" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"';

const SVGS: Record<Exclude<BoatIconId, 'custom'>, string> = {
  ship: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 3 C32 12 34 24 33 42 Q33 45 30 45 L18 45 Q15 45 15 42 C14 24 16 12 24 3 Z" fill="currentColor" ${OUTLINE}/>
    <rect x="19.5" y="24" width="9" height="11" rx="2" fill="#10222f" opacity="0.85"/>
    <path d="M24 9 L24 22" stroke="#10222f" stroke-width="1.6" stroke-linecap="round" opacity="0.6"/>
  </svg>`,
  sailboat: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 2 C31 11 33 22 32 40 Q32 44 29 44 L19 44 Q16 44 16 40 C15 22 17 11 24 2 Z" fill="currentColor" ${OUTLINE}/>
    <path d="M24 12 C33 17 36 27 34 36 L24 36 Z" fill="#ffffff" fill-opacity="0.92" ${OUTLINE} transform="rotate(-8 24 24)"/>
    <path d="M24 12 L24 38" stroke="#10222f" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  arrow: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 3 L40 43 L24 34 L8 43 Z" fill="currentColor" ${OUTLINE}/>
  </svg>`,
  dot: `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <circle cx="24" cy="24" r="19" fill="currentColor" fill-opacity="0.28"/>
    <circle cx="24" cy="24" r="11" fill="currentColor" ${OUTLINE}/>
  </svg>`,
};

export const BOAT_ICONS: { id: BoatIconId; label: string }[] = [
  { id: 'sailboat', label: 'Sailboat' },
  { id: 'ship', label: 'Motor boat' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'dot', label: 'Dot' },
  { id: 'custom', label: 'My own image' },
];

/** Only raster data URLs the image picker produces; anything else could break out of the markup. */
export const isImageDataUrl = (v: unknown): v is string =>
  typeof v === 'string' && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);

export function boatIconMarkup(icon: BoatIconId, customImage: string | null): string {
  if (icon === 'custom') {
    return isImageDataUrl(customImage) ? `<img src="${customImage}" alt="" draggable="false">` : SVGS.sailboat;
  }
  return SVGS[icon] ?? SVGS.sailboat;
}
