// A pressurized EVA glove (after NASA's Phase VI EMU glove) in place of the suit model's thin,
// low-poly hands: a flared fabric gauntlet below the wrist-disconnect ring, a puffy pressurized
// hand with a grey grip palm, and fat fingers in three segments, relaxed and slightly curled,
// with dark silicone (RTV) fingertip caps.
//
// Built in the wrist bone's frame, which at rest is the suit model's frame (metres, +y up, +z
// forward) with its origin at the wrist: the hand hangs down, palm towards the body, thumb
// forward. Built for the model's +x arm; side -1 mirrors it for the other one.
import {
  BufferGeometry, CapsuleGeometry, Group, LatheGeometry, Material, Mesh, MeshPhysicalMaterial,
  MeshStandardMaterial, Object3D, SphereGeometry, Vector2,
} from 'three';

export interface GloveParts {
  readonly geometries: BufferGeometry[];
  readonly materials: Material[];
}

/** shared geometry and materials for both gloves (dispose once) */
export function gloveParts(): GloveParts & {
  fabric: MeshPhysicalMaterial; grip: MeshStandardMaterial; rubber: MeshStandardMaterial;
} {
  const fabric = new MeshPhysicalMaterial({
    color: 0xe7e3db, roughness: .86, sheen: .55, sheenRoughness: .55, sheenColor: 0xe8e8e4,
  });
  // Vectran palm and finger panels: grey, a little shinier than the white cover cloth
  const grip = new MeshStandardMaterial({ color: 0x8a8d92, roughness: .72 });
  const rubber = new MeshStandardMaterial({ color: 0x2a2b2e, roughness: .55 });
  return { fabric, grip, rubber, geometries: [], materials: [fabric, grip, rubber] };
}

/** finger layout: z across the hand (index forward), segment lengths and spread */
const FINGERS = [
  { z: .046, lengths: [.031, .024, .021], fan: -.07 }, // index
  { z: .022, lengths: [.034, .026, .022], fan: -.02 }, // middle
  { z: -.002, lengths: [.032, .025, .021], fan: .03 }, // ring
  { z: -.025, lengths: [.026, .02, .018], fan: .09 }, // little
];
const FINGER_R = .0128;
/** overall size: a pressurized glove is a good deal larger than the hand inside it */
const SIZE = 1.14;
/** relaxed curl towards the palm, per joint (radians) */
const CURL = [.34, .42, .26];

/** a pillowy rounded block (w x h x d): a sphere pushed out to a superellipsoid of exponent k,
 *  like a pressurized fabric bladder; k = 2 is an ellipsoid, larger k squarer */
function pillow(w: number, h: number, d: number, k: number) {
  const g = new SphereGeometry(.5, 28, 20), p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = Math.pow(Math.abs(x) ** k + Math.abs(y) ** k + Math.abs(z) ** k, 1 / k) / .5;
    p.setXYZ(i, x / n * w, y / n * h, z / n * d);
  }
  g.computeVertexNormals();
  return g;
}

export function buildGlove(side: 1 | -1, parts: ReturnType<typeof gloveParts>): Object3D {
  const { fabric, grip, rubber, geometries } = parts;
  const geo = <T extends BufferGeometry>(g: T) => (geometries.push(g), g);
  const add = (parent: Object3D, g: BufferGeometry, m: Material, x: number, y: number, z: number) => {
    const mesh = new Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const glove = new Group();
  glove.name = 'eva-glove';
  // mirrored for the other arm (three.js flips the winding of a negatively scaled mesh)
  glove.scale.set(side * SIZE, SIZE, SIZE);

  // gauntlet: a short flared fabric cuff from under the wrist ring over the top of the hand,
  // flatter across the palm (x) than across the wrist (z)
  // (lathe profiles run bottom to top, so the faces point outwards)
  const cuff = add(glove, geo(new LatheGeometry([
    // closed at both ends: the top fills the ring's opening, the bottom sits on the hand
    new Vector2(0, .014), new Vector2(.069, .014), new Vector2(.066, 0), new Vector2(.062, -.016),
    new Vector2(.064, -.036), new Vector2(.066, -.046), new Vector2(.06, -.056), new Vector2(.045, -.062),
    new Vector2(0, -.063),
  ].reverse(), 40)), fabric, -.008, 0, .009);
  cuff.scale.set(.76, 1, 1);
  // stitched seam where the cuff meets the hand
  const seam = add(glove, geo(new LatheGeometry([
    new Vector2(.0645, -.034), new Vector2(.0672, -.037), new Vector2(.0652, -.04),
  ].reverse(), 40)), grip, -.008, 0, .009);
  seam.scale.set(.76, 1, 1);

  // the hand: a pressurized, pillowy body with a grey grip pad on the palm (-x)
  add(glove, geo(pillow(.054, .104, .1, 3.2)), fabric, -.012, -.092, .011);
  add(glove, geo(pillow(.014, .084, .088, 4)), grip, -.031, -.097, .011);
  // thenar pad at the base of the thumb
  const thenar = add(glove, geo(new SphereGeometry(.03, 18, 12)), fabric, -.018, -.083, .042);
  thenar.scale.set(.62, 1, .78);

  const chain = (root: Object3D, lengths: number[], curl: number[], radius: number) => {
    let joint = root;
    lengths.forEach((len, k) => {
      const next = new Group();
      next.rotation.z = -curl[k]; // towards the palm (-x)
      joint.add(next);
      // the last segment wears the slightly larger rubber fingertip cap; the capsules' round
      // ends overlap at the joints, so the finger reads as one puffy tube with creases
      const last = k === lengths.length - 1;
      const r = last ? radius + .0012 : radius;
      add(next, geo(new CapsuleGeometry(r, len, 4, 12)), last ? rubber : fabric, 0, -len / 2, 0);
      joint = new Group();
      joint.position.y = -len;
      next.add(joint);
    });
  };
  for (const f of FINGERS) {
    const root = new Group();
    root.position.set(-.013, -.134, f.z);
    root.rotation.x = f.fan;
    glove.add(root);
    chain(root, f.lengths, CURL, FINGER_R);
  }
  // thumb: out of the palm's front edge, forward and down, turned towards the fingers
  const thumb = new Group();
  thumb.position.set(-.024, -.093, .055);
  thumb.rotation.set(-.62, 0, -.42);
  glove.add(thumb);
  chain(thumb, [.032, .027], [.12, .25], .0132);
  return glove;
}
