declare module 'lerc' {
  const Lerc: {
    decode(data: ArrayBuffer): {
      width: number;
      height: number;
      pixels: Float32Array[];
      mask: Uint8Array | null;
    };
  };
  export default Lerc;
}
