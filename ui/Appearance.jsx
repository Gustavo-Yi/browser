import React, {createContext,useCallback,useContext,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Sun,Moon,Desktop,Check,ArrowCounterClockwise,Palette} from '@phosphor-icons/react';
import {APPEARANCE_KEY,MODES,defaultAppearance,parseAppearance,validRgb,toHex,fromHex,accentPalette} from './appearance-model.js';

const choices=[{id:'light',label:'浅色模式',Icon:Sun},{id:'dark',label:'深色模式',Icon:Moon},{id:'system',label:'跟随系统',Icon:Desktop}];
const AppearanceContext=createContext(null);
export function AppearanceProvider({children}){
  const [prefs,setPrefs]=useState(()=>{try{return parseAppearance(localStorage.getItem(APPEARANCE_KEY));}catch{return defaultAppearance();}});
  const [systemDark,setSystemDark]=useState(()=>window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [saved,setSaved]=useState(true);
  const latest=useRef(prefs),saveTimer=useRef();latest.current=prefs;
  const flush=useCallback(()=>{
    clearTimeout(saveTimer.current);
    try{localStorage.setItem(APPEARANCE_KEY,JSON.stringify(latest.current));setSaved(true);}catch{setSaved(false);}
  },[]);
  useEffect(()=>{const media=window.matchMedia('(prefers-color-scheme: dark)'),update=()=>setSystemDark(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const resolved=prefs.mode==='system'?(systemDark?'dark':'light'):prefs.mode;
  useLayoutEffect(()=>{
    const root=document.documentElement,palette=accentPalette(prefs.rgb,resolved);
    root.dataset.theme=resolved;root.dataset.themeMode=prefs.mode;root.style.colorScheme=resolved;
    Object.entries(palette).forEach(([key,value])=>root.style.setProperty('--accent-'+key,value));
  },[prefs,resolved]);
  // Paint immediately; persist only after the slider has settled, not on every input event.
  useEffect(()=>{saveTimer.current=setTimeout(flush,160);return()=>clearTimeout(saveTimer.current);},[prefs,flush]);
  useEffect(()=>{
    const hidden=()=>{if(document.visibilityState==='hidden')flush();};
    addEventListener('pagehide',flush);addEventListener('beforeunload',flush);document.addEventListener('visibilitychange',hidden);
    return()=>{flush();removeEventListener('pagehide',flush);removeEventListener('beforeunload',flush);document.removeEventListener('visibilitychange',hidden);};
  },[flush]);
  function setMode(mode){if(MODES.includes(mode))setPrefs(p=>p.mode===mode?p:{...p,mode});}
  function setRgb(rgb){if(validRgb(rgb))setPrefs(p=>p.rgb.every((v,i)=>v===rgb[i])?p:{...p,rgb:[...rgb]});}
  const value={...prefs,resolved,systemDark,saved,setMode,setRgb,flush,reset:()=>setPrefs(defaultAppearance())};
  // App does not subscribe: changing color cannot rerender the entire account list.
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
export const useAppearance=()=>useContext(AppearanceContext);
export function AppearanceShortcut({onOpen}){
  const appearance=useAppearance();
  return <div className="sidebar-appearance"><span className="sidebar-section-label">外观模式</span><ModeChoices compact mode={appearance.mode} onChange={appearance.setMode}/><button className="theme-color-shortcut" onClick={onOpen}><span className="theme-dot"/>自定义主题色</button></div>;
}
export function AppearancePanel({close}){
  const appearance=useAppearance();
  useEffect(()=>()=>appearance.flush(),[appearance.flush]);
  return <AppearanceEditor appearance={appearance} close={()=>{appearance.flush();close();}}/>;
}

export function ModeChoices({mode,onChange,compact=false}){
  return <div role="radiogroup" aria-label={compact?'快捷外观模式':'外观模式'} className={`mode-choices ${compact?'compact':''}`}>
    {choices.map(({id,label,Icon},i)=><button type="button" key={id} role="radio" aria-checked={mode===id} aria-label={label} title={label} tabIndex={mode===id?0:-1} data-mode={id} className={mode===id?'active':''}
      onClick={()=>onChange(id)} onKeyDown={e=>{let next;if(['ArrowLeft','ArrowUp'].includes(e.key))next=(i+2)%3;else if(['ArrowRight','ArrowDown'].includes(e.key))next=(i+1)%3;else if(e.key==='Home')next=0;else if(e.key==='End')next=2;if(next!==undefined){e.preventDefault();onChange(choices[next].id);e.currentTarget.parentElement.children[next].focus();}}}>
      <Icon size={compact?20:25} aria-hidden="true"/><span>{label}</span>
    </button>)}
  </div>;
}

const presets=[['经典蓝','#1263ee'],['鸢尾紫','#8b5cf6'],['松柏绿','#168568'],['日落橙','#ea7724'],['玫瑰红','#dc4267'],['石墨灰','#707070']];
const channelNames=['红色 R','绿色 G','蓝色 B'];
export function AppearanceEditor({appearance,close}){
  const {mode,rgb,setMode,setRgb,saved,reset}=appearance;
  const [drafts,setDrafts]=useState(rgb.map(String)),[error,setError]=useState('');
  useEffect(()=>{setDrafts(rgb.map(String));},[rgb]);
  function setChannel(i,value){const next=[...rgb];next[i]=Number(value);setRgb(next);setError('');}
  function changeDraft(i,value){setDrafts(d=>d.map((x,n)=>n===i?value:x));if(value===''){setError('');return;}if(!/^\d+$/.test(value)||Number(value)>255){setError('RGB 数值范围是 0–255，请输入整数。');return;}setChannel(i,value);}
  const hex=toHex(rgb);
  return <div className="appearance-editor">
    <section aria-labelledby="appearance-mode-label"><h3 id="appearance-mode-label">显示模式</h3><ModeChoices mode={mode} onChange={setMode}/></section>
    <section className="accent-section" aria-labelledby="accent-label"><div className="setting-title"><h3 id="accent-label">主题色</h3></div>
      <div className="color-summary"><label className="native-color" title="打开颜色选择器"><input type="color" id="accent-picker" aria-label="选择主题色" value={hex} onChange={e=>{const color=fromHex(e.target.value);if(color){setRgb(color);setError('');}}}/><Palette size={20} aria-hidden="true"/></label><div><strong>{hex.toUpperCase()}</strong><p>RGB {rgb.join(', ')}</p></div><button type="button" className="button primary accent-example" onClick={e=>{e.currentTarget.blur();}}>按钮预览</button></div>
      <div className="color-presets" aria-label="预设主题色">{presets.map(([name,color])=><button key={name} type="button" title={name} aria-label={`${name}主题色`} aria-pressed={hex===color} data-preset={color} className="color-preset" style={{'--swatch':color}} onClick={()=>{setRgb(fromHex(color));setError('');}}><span className="swatch">{hex===color&&<Check size={16} weight="bold" aria-hidden="true"/>}</span><span>{name}</span></button>)}</div>
      <div className="rgb-channels">{channelNames.map((label,i)=><div className="rgb-channel" key={label}><label htmlFor={`rgb-${i}-number`}>{label}</label><input type="range" id={`rgb-${i}-slider`} aria-label={`${label}滑块`} min="0" max="255" step="1" value={rgb[i]} onChange={e=>setChannel(i,e.target.value)}/><input type="number" id={`rgb-${i}-number`} aria-label={label} aria-describedby={error?'rgb-error':undefined} aria-invalid={drafts[i]!==''&&(!/^\d+$/.test(drafts[i])||Number(drafts[i])>255)} min="0" max="255" step="1" inputMode="numeric" value={drafts[i]} onChange={e=>changeDraft(i,e.target.value)} onBlur={()=>{setDrafts(d=>d.map((v,n)=>n===i?String(rgb[i]):v));setError('');}}/></div>)}</div>
      {error&&<p className="form-error" id="rgb-error" role="alert">{error}</p>}
    </section>
    {!saved&&<p className="form-error" role="alert">外观设置未能保存，仅在当前会话生效。</p>}
    <div className="dialog-actions appearance-actions"><button type="button" className="text-button restore-appearance" onClick={()=>{reset();setError('');}}><ArrowCounterClockwise size={18} aria-hidden="true"/>恢复默认</button><button type="button" className="button primary" onClick={close}>完成</button></div>
  </div>;
}
