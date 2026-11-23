import { createHash } from 'node:crypto';

const palettes = new Map([
  ['blue', {ink:'#182d44', canvas:'#eef5fd', border:'#cbdced', accent:'#315f90', subtle:'#425b76',
    note:'#eef5fc', card:'#f0f5fb', column:'#eaf2fb', control:'#8ca5bf', button:'#244f81', focus:'#845b12'}],
  ['mono', {ink:'#20242a', canvas:'#f1f2f4', border:'#d4d7dd', accent:'#505760', subtle:'#535a64',
    note:'#f0f1f3', card:'#f5f5f7', column:'#ededf0', control:'#959ba4', button:'#333840', focus:'#484e58'}]
]);
const layouts = new Map([
  ['grid', 'main.layout-grid{max-width:64rem}@media(min-width:680px){' +
    '.layout-grid form,.layout-grid .page-content{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:1.2rem}' +
    '.layout-grid form>:not(.field),.layout-grid .page-content>:not(.field){grid-column:1/-1}' +
    '.layout-grid form>button{justify-self:start}}'],
  ['wide', 'main.layout-wide{max-width:80rem}']
]);

export const escape = value => String(value).replace(/[&<>"']/g, character =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);

const languageScript = [
  "const select=document.getElementById('ipm-language');",
  "function showLanguage(){const en=select.value==='en';document.documentElement.lang=en?'en':'zh-CN';",
  "for(const node of document.querySelectorAll('[data-ipm-en]'))node.textContent=en?node.dataset.ipmEn:node.dataset.ipmZh;",
  "for(const node of document.querySelectorAll('[data-ipm-placeholder-en]'))node.placeholder=en?node.dataset.ipmPlaceholderEn:node.dataset.ipmPlaceholderZh;",
  "document.title=document.querySelector('h1').textContent;}",
  "select.addEventListener('change',()=>{showLanguage();try{sessionStorage.setItem('ipm-language',select.value);}catch{}});",
  "try{const saved=sessionStorage.getItem('ipm-language');if(saved==='en'||saved==='zh-CN'){select.value=saved;showLanguage();}}catch{}"
].join('');
export const languageScriptHash = 'sha256-'+createHash('sha256').update(languageScript).digest('base64');

export function pageAppearance({theme, layout, locale, translations} = {}) {
  const lang = locale === 'en' ? 'en' : 'zh-CN';
  const text = (zh,en) => lang === 'en' ? en : zh;
  const label = (zh,en) => ' data-ipm-zh="'+escape(zh)+'" data-ipm-en="'+escape(en)+'"';
  const markup = (zh,en) => '<span'+label(zh,en)+'>'+escape(text(zh,en))+'</span>';
  const placeholder = (zh,en) => ' placeholder="'+escape(text(zh,en))+'"'+
    ' data-ipm-placeholder-zh="'+escape(zh)+'" data-ipm-placeholder-en="'+escape(en)+'"';
  const translated = (pair,value) => pair ? markup(pair['zh-CN'],pair.en) : escape(value);
  const fieldLabel = (ref,value) => translated(Object.hasOwn(translations?.fields ?? {},ref) ? translations.fields[ref] : undefined,value);
  const menu = '<label class="ipm-language">'+markup('语言','Language')+' '+
    '<select id="ipm-language"><option value="zh-CN"'+(lang === 'zh-CN'?' selected':'')+'>简体中文</option>'+
    '<option value="en"'+(lang === 'en'?' selected':'')+'>English</option></select></label>';
  const palette = palettes.get(theme);
  const layoutStyles = layouts.get(layout);
  const colors = palette ?
    ':root{color:'+palette.ink+';background:'+palette.canvas+'}main{border-color:'+palette.border+'}' +
    'header{border-color:'+palette.accent+'}header p,dt,small{color:'+palette.subtle+'}' +
    '.note,.receipt{background:'+palette.note+';border-color:'+palette.accent+'}dl div{background:'+palette.card+'}' +
    'th,td{border-color:'+palette.border+'}th{background:'+palette.column+'}' +
    'input,textarea,select,output{border-color:'+palette.control+'}a{color:'+palette.accent+'}' +
    'button{background:'+palette.button+'}:focus-visible{outline-color:'+palette.focus+'}' : '';
  return {lang, text, label, markup, placeholder, fieldLabel, menu, script:'<script>'+languageScript+'</script>',
    titleText:value=>translations?.title?.[lang] ?? value,
    title:value=>translated(translations?.title,value), purpose:value=>translated(translations?.purpose,value),
    css: colors + (layoutStyles ?? ''),
    mainAttributes: layoutStyles ? ' class="layout-'+layout+'"' : '',
    grid: layout === 'grid'};
}
