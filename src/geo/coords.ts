import type { CoordFormat } from '../types';
import type { LngLat } from './mercator';

export interface ParseOk {
  ok: true;
  lngLat: LngLat;
}
export interface ParseErr {
  ok: false;
  error: string;
}

interface Component {
  value: number; // signed degrees
  axis: 'lat' | 'lng' | null; // from hemisphere letter, if any
}

const SYMBOLS = /[°º˚′″'"’”]/g;

function parseComponent(tokens: string[]): Component | null {
  let letter: string | null = null;
  const nums: number[] = [];
  let negative = false;
  for (const tok of tokens) {
    if (/^[NSEW]$/i.test(tok)) {
      letter = tok.toUpperCase();
    } else {
      const n = parseFloat(tok);
      if (Number.isNaN(n)) return null;
      if (nums.length === 0 && tok.startsWith('-')) negative = true;
      nums.push(nums.length === 0 ? Math.abs(n) : n);
    }
  }
  if (nums.length < 1 || nums.length > 3) return null;
  const [d, m = 0, s = 0] = nums as [number, number?, number?];
  if (m < 0 || m >= 60 || s < 0 || s >= 60) return null;
  let value = d + m / 60 + s / 3600;
  if (negative || letter === 'S' || letter === 'W') value = -value;
  const axis = letter === 'N' || letter === 'S' ? 'lat' : letter === 'E' || letter === 'W' ? 'lng' : null;
  return { value, axis };
}

const tokenize = (s: string): string[] => s.match(/[NSEWnsew]|[-+]?\d+(?:\.\d+)?/g) ?? [];

/**
 * Accepts decimal degrees, degrees + decimal minutes, and degrees/minutes/seconds,
 * with or without hemisphere letters. Examples that all parse:
 *   60.1699, 24.9384
 *   60,1699 24,9384          (decimal comma)
 *   60°10.194'N 24°56.304'E
 *   N 60 10 12  E 24 56 18
 * Without hemisphere letters the order is latitude, then longitude.
 */
export function parseCoordinates(input: string): ParseOk | ParseErr {
  let s = input
    .trim()
    .replace(/\u2212/g, '-')
    .replace(SYMBOLS, ' ')
    .replace(/\s+,/g, ',');
  if (!s) return { ok: false, error: 'Enter coordinates, for example 60.1699, 24.9384.' };

  s = s.replace(/,\s+/g, ';');
  let parts: string[] | null = null;
  if (s.includes(';')) {
    s = s.replace(/,/g, '.');
    parts = s.split(';');
  } else {
    const commas = (s.match(/,/g) ?? []).length;
    if (commas === 1 && !/\s/.test(s)) parts = s.split(',');
    else s = s.replace(/,/g, '.');
  }

  let compA: Component | null;
  let compB: Component | null;

  if (parts) {
    if (parts.length !== 2) return { ok: false, error: 'Use exactly two values: latitude and longitude.' };
    compA = parseComponent(tokenize(parts[0]!));
    compB = parseComponent(tokenize(parts[1]!));
  } else {
    const tokens = tokenize(s);
    const letterIdx = tokens.map((t, i) => (/^[NSEW]$/i.test(t) ? i : -1)).filter((i) => i >= 0);
    let split: number;
    if (letterIdx.length === 2) {
      // Prefix style "N 60 10 E 24 56" or suffix style "60 10 N 24 56 E".
      split = letterIdx[0] === 0 ? letterIdx[1]! : letterIdx[0]! + 1;
    } else if (letterIdx.length === 0) {
      if (tokens.length === 2 || tokens.length === 4 || tokens.length === 6) split = tokens.length / 2;
      else return { ok: false, error: 'Could not read that. Try 60.1699, 24.9384.' };
    } else {
      return { ok: false, error: 'Use two hemisphere letters (N/S and E/W) or none.' };
    }
    compA = parseComponent(tokens.slice(0, split));
    compB = parseComponent(tokens.slice(split));
  }

  if (!compA || !compB) return { ok: false, error: 'Could not read that. Try 60.1699, 24.9384.' };

  let lat: Component;
  let lng: Component;
  if (compA.axis === 'lng' || compB.axis === 'lat') {
    lng = compA;
    lat = compB;
  } else {
    lat = compA;
    lng = compB;
  }
  if ((compA.axis && compA.axis === compB.axis) || lat.axis === 'lng' || lng.axis === 'lat') {
    return { ok: false, error: 'One value must be latitude (N/S) and the other longitude (E/W).' };
  }
  if (Math.abs(lat.value) > 90) return { ok: false, error: 'Latitude must be between -90 and 90.' };
  if (Math.abs(lng.value) > 180) return { ok: false, error: 'Longitude must be between -180 and 180.' };
  return { ok: true, lngLat: [lng.value, lat.value] };
}

function formatAxis(value: number, pos: string, neg: string, format: CoordFormat, degPad: number): string {
  const hemi = value >= 0 ? pos : neg;
  const abs = Math.abs(value);
  if (format === 'decimal') {
    return `${abs.toFixed(4).padStart(degPad + 5, '0')}° ${hemi}`;
  }
  if (format === 'degmin') {
    const milli = Math.round(abs * 60 * 1000);
    const deg = Math.floor(milli / 60000);
    const min = (milli % 60000) / 1000;
    return `${String(deg).padStart(degPad, '0')}°${min.toFixed(3).padStart(6, '0')}′ ${hemi}`;
  }
  const deci = Math.round(abs * 3600 * 10);
  const deg = Math.floor(deci / 36000);
  const rest = deci % 36000;
  const min = Math.floor(rest / 600);
  const sec = (rest % 600) / 10;
  return `${String(deg).padStart(degPad, '0')}°${String(min).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0')}″ ${hemi}`;
}

export function formatCoordinates([lng, lat]: LngLat, format: CoordFormat): string {
  return `${formatAxis(lat, 'N', 'S', format, 2)}   ${formatAxis(lng, 'E', 'W', format, 3)}`;
}
