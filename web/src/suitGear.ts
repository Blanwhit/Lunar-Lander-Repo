// The hard parts of a NASA EVA suit (EMU) that the walk's body model leaves out: helmet with gold
// sun visor, helmet lights and neck ring; the PLSS life-support backpack with its secondary
// oxygen pack; the two umbilical hoses from the backpack round to the chest control module; and
// the US flag patch on the left shoulder. Built from primitives in the suit model's frame (metres,
// +y up, +z forward, +x the wearer's left) and hung on the suit's bones.
import {
  BufferGeometry, CanvasTexture, CatmullRomCurve3, CylinderGeometry, DoubleSide, Group, Material, Mesh,
  MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PlaneGeometry, SphereGeometry, SRGBColorSpace,
  TorusGeometry, TubeGeometry, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/** Layer of the parts only seen from outside (the helmet: the wearer's eye is inside it).
 *  The walk's first-person camera renders layer 0 only; WebXR adds layers 1 and 2 per eye. */
export const THIRD_PERSON_LAYER = 5;

function flagTexture() {
  const w = 190, h = 100, c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 ? '#f4f2ee' : '#b3192b';
    g.fillRect(0, (i * h) / 13, w, h / 13 + 1);
  }
  const cw = w * 0.4, ch = (h * 7) / 13;
  g.fillStyle = '#20325f';
  g.fillRect(0, 0, cw, ch);
  g.fillStyle = '#f4f2ee';
  for (let r = 0; r < 9; r++)
    for (let k = 0; k < (r % 2 ? 5 : 6); k++) {
      g.beginPath();
      g.arc(((k + (r % 2 ? 1 : 0.5)) * cw) / 6.2, ((r + 0.7) * ch) / 9.6, 1.6, 0, Math.PI * 2);
      g.fill();
    }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export interface SuitGear {
  dispose(): void;
}

/**
 * @param torso       the suit's chest bone (rest frame = model frame)
 * @param leftShoulder the wearer's left upper-arm bone and its rest origin in the model frame
 * @param lift        how far the model above the hips was raised (walkSuit's longer legs)
 */
export function addSuitGear(torso: Object3D, leftShoulder: { bone: Object3D; origin: Vector3 }, lift: number): SuitGear {
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const geo = <T extends BufferGeometry>(g: T) => (geometries.push(g), g);
  const mat = <T extends Material>(m: T) => (materials.push(m), m);
  const add = (parent: Object3D, g: BufferGeometry, m: Material, x: number, y: number, z: number) => {
    const mesh = new Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // materials: thermal fabric cover, hard white shells, anodised metal, dark rubber, gold visor
  const cloth = mat(new MeshPhysicalMaterial({ color: 0xeeebe4, roughness: .86, sheen: .5, sheenRoughness: .55, sheenColor: 0xe8e8e4 }));
  const shell = mat(new MeshPhysicalMaterial({ color: 0xf1f0ec, roughness: .32, clearcoat: .6, clearcoatRoughness: .25 }));
  const metal = mat(new MeshStandardMaterial({ color: 0xb9bdc3, metalness: .55, roughness: .35 }));
  const dark = mat(new MeshStandardMaterial({ color: 0x2b2d31, roughness: .6 }));
  const hose = mat(new MeshStandardMaterial({ color: 0xd9d7d1, roughness: .7 }));
  const visor = mat(new MeshPhysicalMaterial({
    color: 0xd9a845, metalness: 1, roughness: .1, clearcoat: 1, clearcoatRoughness: .05, side: DoubleSide,
  }));
  const lens = mat(new MeshStandardMaterial({ color: 0x15171a, roughness: .15, metalness: .4, emissive: 0x0b0c0e }));

  // ---- helmet (third person only): the neck ring sits on the suit's collar
  const helmet = new Group();
  helmet.position.set(0, 1.70 + lift, .055);
  const R = .184;
  add(helmet, geo(new SphereGeometry(R, 48, 32)), shell, 0, 0, 0);
  // gold sun visor over the front, a little proud of the shell
  const vis = add(helmet, geo(new SphereGeometry(R + .006, 48, 24, Math.PI / 2 - .98, 1.96, .62, 1.12)), visor, 0, 0, 0);
  vis.castShadow = false;
  // visor frame: a band along the visor's top edge
  const brow = add(helmet, geo(new TorusGeometry(R * Math.sin(.62) + .004, .009, 10, 40, 2.1)), shell, 0, R * Math.cos(.62), 0);
  brow.rotation.set(Math.PI / 2, 0, Math.PI / 2 - 1.05 + Math.PI);
  // helmet lights on both sides, lenses forward
  for (const s of [-1, 1]) {
    const lamp = add(helmet, geo(new RoundedBoxGeometry(.055, .07, .1, 3, .012)), shell, s * (R + .012), .045, .015);
    lamp.rotation.y = s * .12;
    const glass = add(lamp, geo(new CylinderGeometry(.019, .019, .01, 20)), lens, 0, .005, .051);
    glass.rotation.x = Math.PI / 2;
  }
  const neck = add(helmet, geo(new TorusGeometry(.155, .019, 14, 48)), metal, 0, -.138, 0);
  neck.rotation.x = Math.PI / 2;
  helmet.traverse((o) => o.layers.set(THIRD_PERSON_LAYER));
  torso.add(helmet);

  // ---- PLSS backpack on the back, secondary oxygen pack below it
  const pack = new Group();
  pack.position.set(0, 1.265 + lift, -.255);
  add(pack, geo(new RoundedBoxGeometry(.5, .6, .2, 4, .045)), cloth, 0, 0, 0);
  // seam and lid lines, a slightly darker cover panel on the back face
  add(pack, geo(new RoundedBoxGeometry(.42, .5, .02, 2, .01)), shell, 0, .01, -.1);
  add(pack, geo(new RoundedBoxGeometry(.44, .16, .17, 3, .035)), cloth, 0, -.385, .01);
  add(pack, geo(new RoundedBoxGeometry(.5, .024, .205, 2, .01)), dark, 0, -.3, 0);
  // grab handle across the top
  const handle = add(pack, geo(new TorusGeometry(.09, .011, 8, 24, Math.PI)), metal, 0, .3, -.03);
  handle.rotation.set(0, 0, 0);
  // vent grille and access panel on the back cover, bumpers on the corners
  const vent = add(pack, geo(new RoundedBoxGeometry(.16, .07, .012, 2, .006)), dark, -.1, .19, -.112);
  vent.castShadow = false;
  add(pack, geo(new RoundedBoxGeometry(.12, .16, .012, 2, .008)), shell, .12, -.1, -.112);
  for (const sx of [-1, 1]) for (const sy of [-1, 1])
    add(pack, geo(new RoundedBoxGeometry(.06, .06, .06, 2, .02)), dark, sx * .228, sy * .278, -.075);
  torso.add(pack);

  // ---- umbilical hoses: from the backpack's sides round the waist to the chest control module
  for (const s of [-1, 1]) {
    const curve = new CatmullRomCurve3([
      new Vector3(s * .24, 1.08 + lift, -.2), new Vector3(s * .27, 1.02 + lift, -.04),
      new Vector3(s * .22, 1.06 + lift, .2), new Vector3(s * .1, 1.22 + lift, .27),
      new Vector3(s * .06, 1.3 + lift, .26),
    ]);
    add(torso, geo(new TubeGeometry(curve, 40, .016, 10, false)), hose, 0, 0, 0);
  }

  // ---- US flag on the left shoulder (canton forward)
  const flag = add(leftShoulder.bone, geo(new PlaneGeometry(.1, .053)), mat(new MeshStandardMaterial({
    map: flagTexture(), roughness: .9, polygonOffset: true, polygonOffsetFactor: -2,
  })), .492 - leftShoulder.origin.x, 1.3 + lift - leftShoulder.origin.y, .06 - leftShoulder.origin.z);
  flag.rotation.set(0, Math.PI / 2, 0);
  flag.rotateX(-.08);
  flag.castShadow = false;

  return {
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) {
        (m as MeshStandardMaterial).map?.dispose();
        m.dispose();
      }
    },
  };
}
