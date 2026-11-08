export const APPEARANCE_KEY = 'yt-browser.appearance.v1';
export const MODES = ['light', 'dark', 'system'];
export const DEFAULT_RGB = [18, 99, 238];
export const defaultAppearance = () => ({version: 1, mode: 'system', rgb: [...DEFAULT_RGB]});
export function validRgb(rgb) { return Array.isArray(rgb) && rgb.length === 3 && rgb.every(n => Number.isInteger(n) && n >= 0 && n <= 255); }
export function parseAppearance(raw) {
  try { const p=JSON.parse(raw); return p?.version===1 && MODES.includes(p.mode) && validRgb(p.rgb) ? {version:1, mode:p.mode, rgb:[...p.rgb]} : defaultAppearance(); }
  catch { return defaultAppearance(); }
}
export const toHex = rgb => '#' + rgb.map(n => n.toString(16).padStart(2,'0')).join('');
export function fromHex(hex) { if (!/^#[0-9a-f]{6}$/i.test(hex)) return null; return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)); }
export function luminance(rgb) { const c=rgb.map(n=>{const v=n/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722; }
export function contrast(a,b) {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
export const mix = (a,b,t) => a.map((n,i)=>Math.round(n*(1-t)+b[i]*t));
export function accentPalette(rgb, theme) {
  const black=[0,0,0],white=[255,255,255];
  const on=contrast(rgb,white)>=contrast(rgb,black)?white:black;
  // Button fill is always the exact chosen RGB. Text/focus shades may adapt for readability.
  const surface=theme==='dark'?[37,37,40]:[245,245,246];
  const direction=theme==='dark'?white:black;
  let text=[...rgb];
  for(let step=1;contrast(text,surface)<5 && step<=100;step++)text=mix(rgb,direction,step/100);
  return {fill:toHex(rgb),on:toHex(on),text:toHex(text),hover:toHex(mix(rgb,on[0]===255?black:white,.08)),channels:rgb.join(' ')};
}
