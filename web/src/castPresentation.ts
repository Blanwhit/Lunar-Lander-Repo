let presentation:'closed'|'compact'|'expanded'='closed';

export function setCastPresentation(mode:typeof presentation){
  presentation=mode;
}
export function castExpanded(){
  return presentation==='expanded';
}
export function backgroundRenderDue(now:number,last:number){
  if(castExpanded())return false;
  return presentation==='closed'||now-last>=1000/30-1;
}
