import {
  BufferGeometry, CanvasTexture, Color, DoubleSide, Float32BufferAttribute, Group, Mesh,
  MeshBasicMaterial, Path, PlaneGeometry, Shape, ShapeGeometry, SRGBColorSpace, TextureLoader,
} from 'three';

type Point = [number, number, number];
type XY = [number, number];
type Rect = [number, number, number, number];
type Vehicle = 'command' | 'lunar';

// Coordinates in the 2048 px photo atlas, from its upper-left corner.
const white: Rect = [1700, 1500, 2, 2];
const topPanel: Rect = [8, 8, 1024, 640];
const lowerPanel: Rect = [8, 664, 1024, 208];
const keyboard: Rect = [1048, 8, 320, 352];
const breakers: Rect = [8, 888, 768, 472];
const stowage: Rect = [792, 888, 704, 704];
const hatch: Rect = [1512, 888, 520, 520];
const mainConsole: Rect = [8, 1608, 1432, 424];
const paint: Rect = [1520, 1450, 128, 128];
const front = -.71;
const left = -.68, right = 1.32, back = 1.04, top = .52, floor = -1.57;

function inset(points: XY[], scale: number): XY[] {
  const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return points.map(([x, y]) => [cx + (x - cx) * scale, cy + (y - cy) * scale]);
}

function roundedCorners(points: XY[], amount: number): XY[] {
  const result: XY[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    for (const next of [points[(i + points.length - 1) % points.length], points[(i + 1) % points.length]]) {
      const dx = next[0] - x, dy = next[1] - y;
      const cut = Math.min(amount / Math.hypot(dx, dy), .20);
      result.push([x + dx * cut, y + dy * cut]);
    }
  }
  return result;
}

/** Faces share one texture atlas and one draw call per cabin, including the fasteners and recesses. */
function interior(vehicle: Vehicle, material: MeshBasicMaterial) {
  const vertices: number[] = [], colors: number[] = [], uvs: number[] = [];
  function vertex(p: Point, uv: XY, color: Color) {
    vertices.push(...p);
    colors.push(color.r, color.g, color.b);
    uvs.push(uv[0] / 2048, 1 - uv[1] / 2048);
  }
  function quad(a: Point, b: Point, c: Point, d: Point, rect: Rect, tint: number) {
    const [x, y, w, h] = rect, color = new Color(tint);
    // a..d start at the visually upper-left corner and proceed clockwise.
    const pts = [a, b, c, d];
    const tex: XY[] = [[x+.5, y+.5], [x+w-.5, y+.5], [x+w-.5, y+h-.5], [x+.5, y+h-.5]];
    for (const i of [0, 1, 2, 0, 2, 3]) vertex(pts[i], tex[i], color);
  }
  function face(x: number, y: number, z: number, w: number, h: number, rect: Rect, tint: number, advance = 0) {
    quad([x,y,z], [x+w,y,z], [x+w,y-h,z+advance], [x,y-h,z+advance], rect, tint);
  }
  function rim(outline: XY[], outer: number, z1: number, inner: number, z2: number, tint: number) {
    const a = inset(outline, outer), b = inset(outline, inner);
    for (let i = 0; i < a.length; i++) {
      const j = (i + 1) % a.length;
      quad([...a[i],z1], [...a[j],z1], [...b[j],z2], [...b[i],z2], white, tint);
    }
  }
  function rivet(x: number, y: number, z: number, r: number) {
    const color = new Color();
    for (let k=0; k<8; k++) {
      const a=k*Math.PI/4, b=(k+1)*Math.PI/4;
      color.setRGB(.22+.13*Math.cos(a), .23+.13*Math.cos(a), .23+.13*Math.cos(a));
      for (const p of [[x,y,z+.002],[x+r*Math.cos(a),y+r*Math.sin(a),z],[x+r*Math.cos(b),y+r*Math.sin(b),z]]) {
        vertex(p as Point, [1700,1500], color);
      }
    }
  }
  const lunar = vehicle === 'lunar';
  // Eagle's commander window is widest at the top, falling toward the instrument tower.
  // Convert the NASA photograph's window outline into physical points on the forward wall.
  const fromPhoto = (x: number, y: number): XY => [(x-383)*.0032,(313-y)*.0032];
  const pilotWindow = [[210,246],[227,232],[499,209],[473,317],[461,489],[446,496],[235,281]]
    .map(([x,y]) => fromPhoto(x,y));
  const openings: XY[][] = lunar
    ? [pilotWindow,
       roundedCorners([[.55,.33],[1.26,.34],[1.21,-.57],[.64,-.19]],.05)]
    : [roundedCorners([[-.48,.35],[.34,.35],[.25,-.12],[-.31,-.17]],.08),
       roundedCorners([[.75,.32],[1.18,.29],[1.12,-.10],[.84,-.08]],.06)];
  const surface = new Shape();
  surface.moveTo(left, floor); surface.lineTo(right, floor); surface.lineTo(right, top);
  surface.lineTo(left, top); surface.closePath();
  for (const opening of openings) {
    const hole = new Path();
    hole.moveTo(...opening[0]);
    for (const point of opening.slice(1)) hole.lineTo(...point);
    hole.closePath(); surface.holes.push(hole);
  }
  const wall = new ShapeGeometry(surface);
  const pos = wall.getAttribute('position');
  const color = new Color(lunar ? 0x676b69 : 0x67665f);
  for (const i of wall.index!.array) {
    vertex([pos.getX(i),pos.getY(i),front], [1560 + pos.getX(i)*28,1515 + pos.getY(i)*24], color);
  }
  wall.dispose();

  if (lunar) {
    // Preserve the COAS mount, rubber window seals, sunshield and mounting flange photographed
    // aboard Eagle. The opening itself is cut through to the live stereo view.
    const surround=new Shape();
    surround.moveTo(left,-.77);surround.lineTo(.43,-.77);surround.lineTo(.43,top);
    surround.lineTo(left,top);surround.closePath();
    const opening=new Path();opening.moveTo(...pilotWindow[0]);
    for(const p of pilotWindow.slice(1)) opening.lineTo(...p);
    opening.closePath();surround.holes.push(opening);
    const geometry=new ShapeGeometry(surround);
    const positions=geometry.getAttribute('position');
    const silver=new Color(0xb7b8ae);
    const photoUV=(x:number,y:number):XY=>[
      1376+(x/.0032+383-136)*656/568,8+(313-y/.0032-39)*604/524,
    ];
    for(const i of geometry.index!.array){
      const x=positions.getX(i),y=positions.getY(i);
      vertex([x,y,front+.008],photoUV(x,y),silver);
    }
    geometry.dispose();
    const finder=[fromPhoto(439,204),fromPhoto(483,203),fromPhoto(481,264),fromPhoto(445,268)];
    for (const i of [0,1,2,0,2,3]) {
      const [x,y]=finder[i];
      vertex([x,y,front+.04],photoUV(x,y),silver);
    }
    rim(pilotWindow,1.001,front+.008,.986,front-.042,0x414541);
  }
  for (const window of openings) {
    if(lunar && window===pilotWindow) continue;
    rim(window, 1.16, front+.004, 1.105, front+.034, 0x9a9b8d);
    rim(window, 1.105, front+.034, 1.042, front+.034, 0x53574f);
    rim(window, 1.042, front+.034, 1, front-.053, 0x191f20);
    rim(window, 1, front-.053, .985, front-.065, 0x66665a);
    const edge = inset(window, 1.124);
    for (let i=0; i<edge.length; i++) {
      const p=edge[i], q=edge[(i+1)%edge.length];
      const n=Math.floor(Math.hypot(q[0]-p[0],q[1]-p[1])/.10);
      for (let k=0;k<n;k++) rivet(p[0]+(q[0]-p[0])*(k+.5)/n,p[1]+(q[1]-p[1])*(k+.5)/n,front+.035,.006);
    }
  }
  // Inner pressure vessel and panel bays, with all sides closed when the wearer turns around.
  quad([left,top,back],[left,top,front],[left,floor,front],[left,floor,back],paint,0x6b6d66);
  quad([right,top,front],[right,top,back],[right,floor,back],[right,floor,front],paint,0x646761);
  quad([left,top,front],[right,top,front],[right,top,back],[left,top,back],paint,0x9e9f94);
  quad([right,floor,front],[left,floor,front],[left,floor,back],[right,floor,back],paint,0x4c504c);
  quad([right,top,back],[left,top,back],[left,floor,back],[right,floor,back],stowage,0xb0afa6);
  const ox=.24, oz=.42, r=.51;
  quad([ox-r,top-.012,oz-r],[ox+r,top-.012,oz-r],[ox+r,top-.012,oz+r],[ox-r,top-.012,oz+r],hatch,0xb8b8aa);
  for (const side of [-1,1]) {
    const x=side<0?left+.014:right-.014;
    const start=side<0?.76:-.57, end=side<0?-.57:.76;
    quad([x,-.25,start],[x,-.25,end],[x-side*.07,-.78,end],[x-side*.07,-.78,start],breakers,0xb0b6b1);
    quad([x,top-.02,start],[x,top-.02,end],[x,.39,end],[x,.39,start],white,0x878b81);
    for(let k=0;k<4;k++){
      const z=front+.26+k*.38;
      quad([x,.34,z],[x,.34,z+.019],[x,-.24,z+.019],[x,-.24,z],white,0x7e8076);
    }
  }
  if (lunar) {
    // CDR is on the left of the central instrument tower. The panel faces the work station.
    face(.38,.06,front+.075,.75,.49,topPanel,0xb9bcb5,.035);
    face(.28,-.435,front+.111,.78,.143,lowerPanel,0xb0b2ab,.10);
    face(.535,-.59,front+.222,.244,.267,keyboard,0xb0b3a9,.12);
    face(.272,-.58,front+.219,.254,.22,paint,0x787c75,.09);
    face(.785,-.58,front+.219,.265,.22,paint,0x797d75,.09);
    // Fine Landing Point Designator marks on the commander's window. A sparse reticle
    // allows the plumes and footpad-to-ground motion to remain visible behind the ticks.
    for (let i=0;i<17;i++) {
      const y=.14-i*.029;
      face(.12,y,front-.061,i%5===0?.05:.021,.0018,white,0xaaa99c);
    }
  } else {
    face(-.63,-.23,front+.036,1.86,.49,mainConsole,0xc2c0b5,.21);
    face(-.63,-.727,front+.245,1.86,.029,white,0x363734,.011);
    // Side bolsters and the webbing on the CMP and LMP couches.
    for (const x of [.48,1.01]) {
      quad([x-.18,-.64,.30],[x+.18,-.64,.30],[x+.18,-.34,.98],[x-.18,-.34,.98],paint,0x91968a);
      quad([x-.14,-.63,.33],[x-.10,-.63,.33],[x+.12,-.33,.96],[x+.08,-.33,.96],white,0x504e47);
    }
  }

  const geometry=new BufferGeometry();
  geometry.setAttribute('position',new Float32BufferAttribute(vertices,3));
  geometry.setAttribute('uv',new Float32BufferAttribute(uvs,2));
  geometry.setAttribute('color',new Float32BufferAttribute(colors,3));
  return new Mesh(geometry,material);
}

export function createMissionCabin() {
  const group = new Group();
  group.name = 'Apollo crew station';
  const atlas = new TextureLoader().load(import.meta.env.BASE_URL + 'mission/cabin-atlas.webp');
  atlas.colorSpace=SRGBColorSpace;
  atlas.anisotropy=4;
  const panelMaterial=new MeshBasicMaterial({map:atlas,vertexColors:true,side:DoubleSide,toneMapped:false});
  const lunar=interior('lunar',panelMaterial), command=interior('command',panelMaterial);
  group.add(lunar,command);

  // The DSKY's Program 64/66 displays use altitude and altitude rate in feet and feet/second.
  // The canvas covers only the electroluminescent display, retaining the photographed keypad.
  const display=document.createElement('canvas');
  display.width=192; display.height=240;
  const ctx=display.getContext('2d')!;
  const readout=new CanvasTexture(display);
  readout.colorSpace=SRGBColorSpace;
  const displayMaterial=new MeshBasicMaterial({map:readout,toneMapped:false});
  const displayFace=new Mesh(new PlaneGeometry(.076,.107),displayMaterial);
  displayFace.rotation.x=-Math.atan2(.12,.267);
  displayFace.position.set(.71,-.656,front+.222+.066*.12/.267+.004);
  lunar.add(displayFace);
  const contactMaterial=new MeshBasicMaterial({color:0x244053,toneMapped:false});
  const contactLamp=new Mesh(new PlaneGeometry(.016,.013),contactMaterial);
  contactLamp.position.set(.561,-.057,front+.075+.117*.035/.49+.003);
  lunar.add(contactLamp);
  let lastReadout='';
  function update(altitude:number,speed:number,contact:boolean) {
    const feet=Math.min(99999,Math.round(Math.max(0,altitude)*3.28084));
    const rate=Math.min(9999,Math.round(Math.abs(speed)*3.28084*10));
    const key=feet+'/'+rate+'/'+contact;
    if(key===lastReadout)return;
    lastReadout=key;
    ctx.fillStyle='#111c14';ctx.fillRect(0,0,192,240);
    ctx.fillStyle='#aaceab';ctx.font='bold 17px monospace';
    ctx.fillText('PROG',9,24);ctx.fillText('VERB',9,83);ctx.fillText('NOUN',103,83);
    ctx.fillStyle='#98f29b';ctx.font='32px monospace';
    ctx.fillText(altitude>120?'64':'66',106,43);
    ctx.fillText('16',9,115);ctx.fillText('63',105,115);
    ctx.fillText('+'+String(feet).padStart(5,'0'),14,170);
    ctx.fillText((speed>0?'-':'+')+String(rate).padStart(5,'0'),14,213);
    readout.needsUpdate=true;
    contactMaterial.color.set(contact?0x77d6ff:0x244053);
  }
  update(0,0,false);
  command.visible=false;
  return {
    group,
    setVehicle(kind:Vehicle) {lunar.visible=kind==='lunar'; command.visible=!lunar.visible;},
    update,
    dispose() {
      group.removeFromParent();
      for(const mesh of [lunar,command,displayFace,contactLamp])mesh.geometry.dispose();
      panelMaterial.dispose(); displayMaterial.dispose(); contactMaterial.dispose();
      atlas.dispose(); readout.dispose();
    },
  };
}
